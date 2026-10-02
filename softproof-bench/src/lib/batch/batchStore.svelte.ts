/**
 * Batch proofing jobs ("批次打样作业") — store, queue runner and recovery.
 *
 *  - Every entry freezes its original bytes + full conversion settings in
 *    IndexedDB; the queue survives a refresh and only unfinished entries
 *    resume (finished outputs are never regenerated).
 *  - The runner processes one item at a time through the color worker. Each
 *    run is an "attempt" carrying the worker task id; completion is applied
 *    through an atomic read-modify-write that re-checks status, attempt id
 *    and the settings signature, so a late result can never overwrite an
 *    entry that was cancelled or re-configured while it was in flight.
 *  - Files already carrying this tool's conversion marker are refused: a
 *    converted output must never re-enter as a new original.
 */
import {
  idbAll,
  idbAllByIndex,
  idbDelete,
  idbGet,
  idbPut,
  idbUpdate,
  STORE_BATCH_ITEMS,
  STORE_BATCHES,
  type StoredProfile,
} from '../db/db';
import { detectContainer, extractEmbeddedICC } from '../icc/extractEmbedded';
import { readProfileInfo } from '../icc/profileInfo';
import { detectProvenance } from '../icc/provenance';
import { fnv1a64 } from '../color/hash';
import { cancelTask, isTaskCancelled, startConvert } from '../workers/client';
import { downloadBytes } from '../codec/export';
import { APP_VERSION } from '../color/record';
import { buildBatchExport } from './exportBatch';
import {
  isTerminal,
  recoveryTransition,
  settingsKeyOf,
  type BatchAttempt,
  type BatchItemStatus,
  type BatchTargetSettings,
  type StoredBatch,
  type StoredBatchItem,
} from './types';
import type { RenderingIntent } from '../color/lcms';

let uid = 1;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${uid++}`;
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BatchDefaults {
  targetProfileId: string | null;
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  proofIntent: RenderingIntent;
}

export interface ReconfigurePatch {
  /** 'embedded' to switch back to the embedded ICC, or a library profile id. */
  sourceProfileId: string | 'embedded';
  targetProfileId: string;
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  proofIntent: RenderingIntent;
}

function createBatchStore() {
  const state = $state({
    ready: false,
    batches: [] as StoredBatch[],
    activeBatchId: null as string | null,
    /** Items of the active batch, ordered by seq. */
    items: [] as StoredBatchItem[],
    notice: '',
    running: false,
    exporting: false,
  });

  let pumping = false;
  let pumpAgain = false;
  let initPromise: Promise<void> | null = null;

  const activeBatch = () => state.batches.find((b) => b.id === state.activeBatchId) ?? null;

  async function refreshItems() {
    if (!state.activeBatchId) {
      state.items = [];
      return;
    }
    const items = await idbAllByIndex<StoredBatchItem>(STORE_BATCH_ITEMS, 'by-batch', state.activeBatchId);
    items.sort((a, b) => a.seq - b.seq);
    state.items = items;
  }

  async function refreshBatches() {
    state.batches = (await idbAll<StoredBatch>(STORE_BATCHES)).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  /**
   * Load persisted jobs and resume unfinished work. A `converting` entry at
   * this point belongs to a dead session: demote it to queued (attempt closed
   * as interrupted) so the runner re-runs it; terminal entries are untouched.
   */
  async function init() {
    initPromise ??= initInner();
    return initPromise;
  }

  async function initInner() {
    if (state.ready) return;
    const all = await idbAll<StoredBatchItem>(STORE_BATCH_ITEMS);
    const stamp = now();
    for (const item of all) {
      if (item.status !== 'converting') continue;
      await idbUpdate<StoredBatchItem>(STORE_BATCH_ITEMS, item.id, (cur) =>
        cur && cur.status === 'converting' ? recoveryTransition(cur, stamp) : undefined,
      );
    }
    await refreshBatches();
    state.activeBatchId = state.batches[0]?.id ?? null;
    await refreshItems();
    state.ready = true;
    void pump();
  }

  async function createBatch(name: string, defaults: BatchDefaults): Promise<void> {
    const batch: StoredBatch = {
      id: newId('batch'),
      name: name.trim() || `批次 ${new Date().toLocaleString()}`,
      createdAt: now(),
      updatedAt: now(),
      defaults,
    };
    await idbPut(STORE_BATCHES, batch);
    await refreshBatches();
    state.activeBatchId = batch.id;
    await refreshItems();
  }

  async function selectBatch(id: string) {
    state.activeBatchId = id;
    await refreshItems();
  }

  async function updateDefaults(defaults: BatchDefaults) {
    const b = activeBatch();
    if (!b) return;
    // Plain object, not the $state proxy (see addFiles).
    await idbPut(STORE_BATCHES, {
      id: b.id,
      name: b.name,
      createdAt: b.createdAt,
      updatedAt: now(),
      defaults: { ...defaults },
    });
    await refreshBatches();
  }

  async function deleteBatch(id: string) {
    const items = await idbAllByIndex<StoredBatchItem>(STORE_BATCH_ITEMS, 'by-batch', id);
    for (const item of items) {
      if (item.status === 'converting' && item.activeTaskId != null) cancelTask(item.activeTaskId);
      await idbDelete(STORE_BATCH_ITEMS, item.id);
    }
    await idbDelete(STORE_BATCHES, id);
    await refreshBatches();
    if (state.activeBatchId === id) {
      state.activeBatchId = state.batches[0]?.id ?? null;
      await refreshItems();
    }
  }

  function resolveTarget(defaults: BatchDefaults, profiles: StoredProfile[]): BatchTargetSettings | null {
    const p = profiles.find((x) => x.id === defaults.targetProfileId);
    if (!p) return null;
    return {
      targetProfileId: p.id,
      targetDescription: p.description,
      targetColorSpace: p.colorSpace,
      targetIcc: p.bytes,
      intent: defaults.intent,
      blackPointCompensation: defaults.blackPointCompensation,
      proofIntent: defaults.proofIntent,
    };
  }

  /**
   * Import originals into the active batch. Embedded-ICC files are frozen and
   * queued immediately; files without a profile wait at `pending-confirm`
   * until the operator explicitly chooses a source. Files carrying a
   * conversion marker are refused. Exact duplicates (same bytes AND same
   * frozen settings) are skipped; the same bytes under a different assumption
   * are a different job and are kept separately.
   */
  async function addFiles(files: File[], profiles: StoredProfile[]): Promise<void> {
    try {
      await addFilesInner(files, profiles);
    } catch (err) {
      state.notice = `加入原稿失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function addFilesInner(files: File[], profiles: StoredProfile[]): Promise<void> {
    const batch = activeBatch();
    if (!batch) {
      state.notice = '请先创建一个批次。';
      return;
    }
    const target = resolveTarget(batch.defaults, profiles);
    if (!target) {
      state.notice = '批次默认目标配置不在配置库中，请先在批次设置里重新选择。';
      return;
    }
    const existing = await idbAllByIndex<StoredBatchItem>(STORE_BATCH_ITEMS, 'by-batch', batch.id);
    let seq = existing.reduce((m, x) => Math.max(m, x.seq), 0);
    const keys = new Set(existing.map((x) => x.settingsKey).filter(Boolean));
    const skipped: string[] = [];
    const refused: string[] = [];
    let added = 0;

    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const container = detectContainer(bytes);
      if (container === 'unknown') {
        skipped.push(`${file.name}（不支持的格式）`);
        continue;
      }
      const provenance = detectProvenance(bytes);
      if (provenance.converted) {
        // A converted export must never re-enter as an original.
        refused.push(file.name);
        continue;
      }
      const embedded = extractEmbeddedICC(bytes);
      const info = embedded ? readProfileInfo(embedded) : null;
      const imageHash = fnv1a64(bytes);
      const stamp = now();

      let source: StoredBatchItem['source'] = null;
      let settingsKey = '';
      let status: BatchItemStatus = 'pending-confirm';
      if (embedded && info?.valid) {
        source = {
          kind: 'embedded',
          profileId: null,
          description: info.description || `嵌入配置 (${info.colorSpaceSig.trim()})`,
          colorSpace: info.colorSpace,
          icc: embedded,
        };
        settingsKey = settingsKeyOf(imageHash, source, target);
        status = 'queued';
        if (keys.has(settingsKey)) {
          skipped.push(`${file.name}（与现有条目完全相同，已跳过）`);
          continue;
        }
      }

      const item: StoredBatchItem = {
        id: newId('item'),
        batchId: batch.id,
        seq: ++seq,
        name: file.name,
        addedAt: stamp,
        updatedAt: stamp,
        status,
        imageBytes: bytes,
        imageHash,
        container,
        bitDepth: container === 'png' && bytes[24] === 16 ? 16 : 8,
        embeddedIcc: embedded,
        target,
        source,
        settingsKey,
        activeAttemptId: null,
        activeTaskId: null,
        attempts: [],
        result: null,
        lastError: '',
      };
      await idbPut(STORE_BATCH_ITEMS, item);
      if (settingsKey) keys.add(settingsKey);
      added++;
    }

    if (added) {
      // Persist a plain object: state.batches elements are Svelte $state
      // proxies, and proxies cannot be structured-cloned into IndexedDB.
      await idbPut(STORE_BATCHES, {
        id: batch.id,
        name: batch.name,
        createdAt: batch.createdAt,
        updatedAt: now(),
        defaults: { ...batch.defaults },
      });
    }
    await refreshBatches();
    await refreshItems();
    const notes: string[] = [];
    if (added) notes.push(`已加入 ${added} 个条目`);
    if (skipped.length) notes.push(`已跳过：${skipped.join('、')}`);
    if (refused.length)
      notes.push(`已拒绝（带本工具转换标记，不能当作原图）：${refused.join('、')}`);
    if (notes.length) state.notice = notes.join('；');
    void pump();
  }

  /** Duplicate check inside one batch: identical bytes + identical settings. */
  async function findDuplicate(batchId: string, settingsKey: string, exceptItemId: string): Promise<boolean> {
    if (!settingsKey) return false;
    const items = await idbAllByIndex<StoredBatchItem>(STORE_BATCH_ITEMS, 'by-batch', batchId);
    return items.some((x) => x.id !== exceptItemId && x.settingsKey === settingsKey);
  }

  /**
   * Confirm the source profile for an item whose original has no embedded
   * ICC. The choice is frozen as an explicit assumption and the item enters
   * the queue; until this happens the item never leaves `pending-confirm`.
   */
  async function confirmSource(itemId: string, profileId: string, profiles: StoredProfile[]): Promise<void> {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    const item = state.items.find((x) => x.id === itemId) ?? (await idbGetItem(itemId));
    if (!item || item.status !== 'pending-confirm') return;
    const source: StoredBatchItem['source'] = {
      kind: 'assumed',
      profileId: profile.id,
      description: profile.description,
      colorSpace: profile.colorSpace,
      icc: profile.bytes,
      assumptionNote: '原图缺少嵌入配置，操作员手动选择源配置（假设已记录）',
    };
    const key = settingsKeyOf(item.imageHash, source, item.target);
    if (await findDuplicate(item.batchId, key, itemId)) {
      state.notice = `「${item.name}」与该批次中另一条目的原图和设置完全相同，未重复入队。`;
      return;
    }
    await idbUpdate<StoredBatchItem>(STORE_BATCH_ITEMS, itemId, (cur) => {
      if (!cur || cur.status !== 'pending-confirm') return undefined;
      cur.source = source;
      cur.settingsKey = key;
      cur.status = 'queued';
      cur.updatedAt = now();
      return cur;
    });
    await refreshItems();
    void pump();
  }

  /**
   * Re-freeze an entry with new settings (non-converting states only). The
   * old result is discarded because it no longer matches the configuration;
   * the attempt history is kept. Any late result from before the change is
   * dropped by the settingsKey guard in the runner.
   */
  async function reconfigure(itemId: string, patch: ReconfigurePatch, profiles: StoredProfile[]): Promise<void> {
    const item = state.items.find((x) => x.id === itemId) ?? (await idbGetItem(itemId));
    if (!item || item.status === 'converting') return;
    const targetProfile = profiles.find((p) => p.id === patch.targetProfileId);
    if (!targetProfile) {
      state.notice = '目标配置不在配置库中。';
      return;
    }
    let source: StoredBatchItem['source'];
    if (patch.sourceProfileId === 'embedded') {
      if (!item.embeddedIcc) return;
      const info = readProfileInfo(item.embeddedIcc);
      source = {
        kind: 'embedded',
        profileId: null,
        description: info.description || '嵌入配置',
        colorSpace: info.colorSpace,
        icc: item.embeddedIcc,
      };
    } else {
      const sp = profiles.find((p) => p.id === patch.sourceProfileId);
      if (!sp) return;
      source = {
        kind: 'assumed',
        profileId: sp.id,
        description: sp.description,
        colorSpace: sp.colorSpace,
        icc: sp.bytes,
        assumptionNote: item.embeddedIcc
          ? '原图含嵌入配置，操作员改用库中配置（假设已记录）'
          : '原图缺少嵌入配置，操作员手动选择源配置（假设已记录）',
      };
    }
    const target: BatchTargetSettings = {
      targetProfileId: targetProfile.id,
      targetDescription: targetProfile.description,
      targetColorSpace: targetProfile.colorSpace,
      targetIcc: targetProfile.bytes,
      intent: patch.intent,
      blackPointCompensation: patch.blackPointCompensation,
      proofIntent: patch.proofIntent,
    };
    const key = settingsKeyOf(item.imageHash, source, target);
    if (await findDuplicate(item.batchId, key, itemId)) {
      state.notice = `「${item.name}」修改后与该批次中另一条目完全相同，未应用。`;
      return;
    }
    await idbUpdate<StoredBatchItem>(STORE_BATCH_ITEMS, itemId, (cur) => {
      if (!cur || cur.status === 'converting') return undefined;
      cur.source = source;
      cur.target = target;
      cur.settingsKey = key;
      cur.result = null;
      cur.lastError = '';
      cur.status = 'queued';
      cur.updatedAt = now();
      return cur;
    });
    await refreshItems();
    void pump();
  }

  /** Requeue a terminal (failed/cancelled) entry; the retry is a new attempt. */
  async function retry(itemId: string): Promise<void> {
    await idbUpdate<StoredBatchItem>(STORE_BATCH_ITEMS, itemId, (cur) => {
      if (!cur || (cur.status !== 'failed' && cur.status !== 'cancelled')) return undefined;
      cur.status = 'queued';
      cur.updatedAt = now();
      return cur;
    });
    await refreshItems();
    void pump();
  }

  /**
   * Cancel a queued or converting entry. The status flips inside one
   * transaction, so a worker result racing the cancel loses the check and is
   * discarded; the worker task itself is told to stop at its next checkpoint.
   */
  async function cancel(itemId: string): Promise<void> {
    let taskId: number | null = null;
    await idbUpdate<StoredBatchItem>(STORE_BATCH_ITEMS, itemId, (cur) => {
      if (!cur || (cur.status !== 'queued' && cur.status !== 'converting')) return undefined;
      const stamp = now();
      if (cur.status === 'converting' && cur.activeAttemptId) {
        taskId = cur.activeTaskId;
        cur.attempts = cur.attempts.map((a) =>
          a.id === cur.activeAttemptId && !a.outcome
            ? { ...a, finishedAt: stamp, outcome: 'cancelled' as const, error: '操作员取消' }
            : a,
        );
      }
      cur.status = 'cancelled';
      cur.activeAttemptId = null;
      cur.activeTaskId = null;
      cur.updatedAt = stamp;
      return cur;
    });
    if (taskId != null) cancelTask(taskId);
    await refreshItems();
  }

  async function removeItem(itemId: string): Promise<void> {
    const item = state.items.find((x) => x.id === itemId) ?? (await idbGetItem(itemId));
    if (item && (item.status === 'queued' || item.status === 'converting')) await cancel(itemId);
    await idbDelete(STORE_BATCH_ITEMS, itemId);
    await refreshItems();
  }

  /** Next queued entry across all batches (recovered jobs resume too). */
  async function nextQueued(): Promise<StoredBatchItem | undefined> {
    const queued = await idbAllByIndex<StoredBatchItem>(STORE_BATCH_ITEMS, 'by-status', 'queued');
    queued.sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.seq - b.seq);
    return queued[0];
  }

  /** Serial queue pump: one conversion at a time through the worker. */
  async function pump(): Promise<void> {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    state.running = true;
    try {
      do {
        pumpAgain = false;
        let next: StoredBatchItem | undefined;
        while ((next = await nextQueued())) {
          try {
            await processItem(next.id);
          } catch (err) {
            // Persistence-level failure (not a conversion failure): mark the
            // entry failed so the queue never stalls on it.
            console.error('批次条目处理异常', err);
            const msg = err instanceof Error ? err.message : String(err);
            await idbUpdate<StoredBatchItem>(STORE_BATCH_ITEMS, next.id, (cur) => {
              if (!cur || isTerminal(cur.status)) return undefined;
              cur.status = 'failed';
              cur.lastError = msg;
              cur.activeAttemptId = null;
              cur.activeTaskId = null;
              cur.updatedAt = now();
              return cur;
            });
          }
          if (next.batchId === state.activeBatchId) await refreshItems();
        }
      } while (pumpAgain);
    } finally {
      pumping = false;
      state.running = false;
    }
  }

  async function processItem(itemId: string): Promise<void> {
    const attemptId = newId('att');
    const startedAt = now();
    // Claim the entry: queued -> converting, appending a fresh attempt record.
    const claimed = await idbUpdate<StoredBatchItem>(STORE_BATCH_ITEMS, itemId, (cur) => {
      if (!cur || cur.status !== 'queued' || !cur.source) return undefined;
      const attempt: BatchAttempt = {
        id: attemptId,
        taskId: null,
        startedAt,
        settingsKey: cur.settingsKey,
      };
      cur.status = 'converting';
      cur.activeAttemptId = attemptId;
      cur.activeTaskId = null;
      cur.attempts = [...cur.attempts, attempt];
      cur.updatedAt = startedAt;
      return cur;
    });
    if (!claimed || !claimed.source) return;
    const settingsKey = claimed.settingsKey;
    if (claimed.batchId === state.activeBatchId) await refreshItems();

    const handle = startConvert({
      imageBytes: claimed.imageBytes,
      sourceIcc: claimed.source.icc,
      targetIcc: claimed.target.targetIcc,
      params: {
        intent: claimed.target.intent,
        blackPointCompensation: claimed.target.blackPointCompensation,
        proofIntent: claimed.target.proofIntent,
      },
    });
    // Persist the worker task id so cancel() can address this exact task.
    await idbUpdate<StoredBatchItem>(STORE_BATCH_ITEMS, itemId, (cur) => {
      if (!cur || cur.status !== 'converting' || cur.activeAttemptId !== attemptId) return undefined;
      cur.activeTaskId = handle.id;
      cur.attempts = cur.attempts.map((a) => (a.id === attemptId ? { ...a, taskId: handle.id } : a));
      return cur;
    });

    // Test/demo hook: widen the converting window AFTER the task is posted,
    // so E2E can deterministically reload mid-conversion or land a cancel
    // before the (already computed) worker result is applied.
    const delayMs = Number((globalThis as Record<string, unknown>).__SOFTPROOF_BATCH_DELAY_MS ?? 0);
    if (delayMs > 0) await sleep(delayMs);

    try {
      const payload = await handle.promise;
      const finishedAt = now();
      // Apply only if the entry is still this attempt with unchanged settings;
      // otherwise the result is late (cancelled / re-configured) and dropped.
      const applied = await idbUpdate<StoredBatchItem>(STORE_BATCH_ITEMS, itemId, (cur) => {
        if (
          !cur ||
          cur.status !== 'converting' ||
          cur.activeAttemptId !== attemptId ||
          cur.settingsKey !== settingsKey
        )
          return undefined;
        cur.status = 'succeeded';
        cur.result = { ...payload, attemptId, settingsKey, finishedAt };
        cur.attempts = cur.attempts.map((a) =>
          a.id === attemptId ? { ...a, finishedAt, outcome: 'succeeded' as const } : a,
        );
        cur.activeAttemptId = null;
        cur.activeTaskId = null;
        cur.lastError = '';
        cur.updatedAt = finishedAt;
        return cur;
      });
      if (!applied) console.warn(`批次条目 ${itemId} 的迟到结果已丢弃（条目已取消或配置已更改）`);
    } catch (err) {
      const finishedAt = now();
      if (isTaskCancelled(err)) {
        // cancel() normally owns the transition; close the attempt only if it
        // is still ours and still marked converting.
        await idbUpdate<StoredBatchItem>(STORE_BATCH_ITEMS, itemId, (cur) => {
          if (!cur || cur.status !== 'converting' || cur.activeAttemptId !== attemptId) return undefined;
          cur.status = 'cancelled';
          cur.attempts = cur.attempts.map((a) =>
            a.id === attemptId && !a.outcome ? { ...a, finishedAt, outcome: 'cancelled' as const } : a,
          );
          cur.activeAttemptId = null;
          cur.activeTaskId = null;
          cur.updatedAt = finishedAt;
          return cur;
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        const applied = await idbUpdate<StoredBatchItem>(STORE_BATCH_ITEMS, itemId, (cur) => {
          if (
            !cur ||
            cur.status !== 'converting' ||
            cur.activeAttemptId !== attemptId ||
            cur.settingsKey !== settingsKey
          )
            return undefined;
          cur.status = 'failed';
          cur.lastError = msg;
          cur.attempts = cur.attempts.map((a) =>
            a.id === attemptId ? { ...a, finishedAt, outcome: 'failed' as const, error: msg } : a,
          );
          cur.activeAttemptId = null;
          cur.activeTaskId = null;
          cur.updatedAt = finishedAt;
          return cur;
        });
        if (!applied) console.warn(`批次条目 ${itemId} 的迟到失败结果已丢弃`);
      }
    }
  }

  /** Export the whole batch: per-item image + settings record, plus manifest. */
  async function exportBatch(): Promise<void> {
    const batch = activeBatch();
    if (!batch || state.exporting) return;
    state.exporting = true;
    try {
      const items = await idbAllByIndex<StoredBatchItem>(STORE_BATCH_ITEMS, 'by-batch', batch.id);
      const built = await buildBatchExport(batch, items, APP_VERSION);
      let delay = 0;
      for (const f of built.files) {
        setTimeout(() => downloadBytes(f.name, f.bytes, f.mime), delay);
        delay += 150;
      }
      setTimeout(
        () => downloadBytes(built.manifest.name, built.manifest.bytes, 'application/json'),
        delay,
      );
      const okCount = built.entries.filter((e) => e.output).length;
      state.notice = `已导出批次清单与 ${okCount} 个条目的输出（共 ${built.files.length + 1} 个文件）。`;
    } catch (err) {
      state.notice = `批次导出失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      state.exporting = false;
    }
  }

  /** Export a single succeeded entry (image + its settings record). */
  async function exportItem(itemId: string): Promise<void> {
    const batch = activeBatch();
    const item = state.items.find((x) => x.id === itemId);
    if (!batch || !item || item.status !== 'succeeded') return;
    const built = await buildBatchExport(batch, [item], APP_VERSION);
    let delay = 0;
    for (const f of built.files) {
      setTimeout(() => downloadBytes(f.name, f.bytes, f.mime), delay);
      delay += 150;
    }
  }

  return {
    state,
    init,
    createBatch,
    selectBatch,
    updateDefaults,
    deleteBatch,
    addFiles,
    confirmSource,
    reconfigure,
    retry,
    cancel,
    removeItem,
    exportBatch,
    exportItem,
  };
}

async function idbGetItem(id: string): Promise<StoredBatchItem | undefined> {
  return idbGet<StoredBatchItem>(STORE_BATCH_ITEMS, id);
}

export type BatchStore = ReturnType<typeof createBatchStore>;

let singleton: BatchStore | null = null;
export function getBatchStore(): BatchStore {
  singleton ??= createBatchStore();
  return singleton;
}
