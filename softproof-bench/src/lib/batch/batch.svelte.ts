/**
 * Local batch proofing jobs ("本机批次打样作业").
 *
 * A batch is a list of items that each FREEZE the original master bytes plus
 * the exact source/target profile snapshots, intent and BPC. The manager owns
 * a one-worker queue, the attempt history, crash recovery and the race guards
 * that prevent late worker results from touching changed or canceled items.
 *
 * Persistence (IndexedDB, survives reload):
 *  - batch-jobs     job metadata + frozen defaults
 *  - batch-items    frozen bytes, settings, status, FULL attempt history
 *  - batch-outputs  one converted output per SUCCESSFUL attempt (retry => new)
 */
import {
  idbAll,
  idbAtomicPut,
  idbDelete,
  idbGet,
  idbGetAllByIndex,
  idbPut,
  STORE_BATCH_JOBS,
  STORE_BATCH_ITEMS,
  STORE_BATCH_OUTPUTS,
  STORE_PROFILES,
  type StoredBatchItem,
  type StoredBatchJob,
  type StoredBatchOutput,
  type StoredProfile,
} from '../db/db';
import { detectContainer, extractEmbeddedICC } from '../icc/extractEmbedded';
import { readProfileInfo } from '../icc/profileInfo';
import { detectProvenance } from '../icc/provenance';
import { fnv1a64 } from '../color/hash';
import { runConvertToken, cancelConvert, type ConvertedPayload } from '../workers/client';
import type { RenderingIntent } from '../color/intents';
import {
  acceptResultCheck,
  canAddToBatch,
  canTransition,
  finalizeAttempt,
  isTerminal,
  missingConfirmations,
  recoverStatus,
} from './guards';
import type {
  BatchAttempt,
  BatchItemStatus,
  BatchItemView,
  BatchJobView,
  FrozenProfile,
} from './types';

let uid = 1;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${uid++}`;

interface InFlight {
  jobId: string;
  itemId: string;
  attemptId: string;
  requestId: number;
  settingsRevision: number;
}

/** Frozen snapshot of a library profile (deep-copied bytes). */
export function frozenFromStoredProfile(p: StoredProfile): FrozenProfile {
  return {
    refId: p.id,
    description: p.description,
    colorSpace: p.colorSpace,
    origin: p.origin === 'builtin-open' ? 'builtin-open' : 'user-imported',
    bytes: p.bytes.slice(),
    byteLength: p.bytes.byteLength,
  };
}

function frozenEmbedded(bytes: Uint8Array): FrozenProfile {
  const info = readProfileInfo(bytes);
  return {
    refId: 'embedded:' + (info.profileId || fnv1a64(bytes).slice(0, 12)),
    description: info.description || `嵌入配置 (${info.colorSpaceSig.trim() || '?'})`,
    colorSpace: info.colorSpace,
    origin: 'embedded',
    bytes: bytes.slice(),
    byteLength: bytes.byteLength,
    profileId: info.profileId || undefined,
  };
}

function toView(stored: StoredBatchItem, bytesLoaded = false): BatchItemView {
  const { imageBytes: _imageBytes, ...viewFields } = stored;
  void _imageBytes;
  return {
    ...viewFields,
    embeddedProfile: stored.embeddedProfile ? { ...stored.embeddedProfile } : null,
    source: stored.source ? { ...stored.source } : null,
    target: stored.target ? { ...stored.target } : null,
    bytesLoaded,
  };
}

/** Settings that freeze a conversion; editing is locked while converting/succeeded. */
function isSettingsLocked(status: BatchItemStatus): boolean {
  return status === 'converting' || status === 'succeeded';
}

function createBatchManagerState() {
  const state = $state({
    ready: false,
    jobs: [] as BatchJobView[],
    activeJobId: null as string | null,
    notice: '' as string,
  });

  /** profile library, supplied by app init / refreshed on imports */
  let profiles: StoredProfile[] = [];
  /** full stored records with bytes (memory working set; reload lazily) */
  const itemRecords = new Map<string, StoredBatchItem>();
  const inFlight = new Map<string, InFlight>(); // itemId -> in-flight
  let queueRunning = false;

  function jobView(id: string): BatchJobView | undefined {
    return state.jobs.find((j) => j.id === id);
  }
  function itemView(jobId: string, itemId: string): BatchItemView | undefined {
    return jobView(jobId)?.items.find((i) => i.id === itemId);
  }

  function setProfiles(list: StoredProfile[]) {
    profiles = list;
  }

  // ---------------------------------------------------------------- loading

  async function init() {
    const [jobsStored, itemsStored, profs] = await Promise.all([
      idbAll<StoredBatchJob>(STORE_BATCH_JOBS),
      idbAll<StoredBatchItem>(STORE_BATCH_ITEMS),
      idbAll<StoredProfile>(STORE_PROFILES),
    ]);
    profiles = profs;

    const itemsByJob = new Map<string, StoredBatchItem[]>();
    for (const it of itemsStored) {
      const recovered = recoverStatus(it.status);
      const changed = recovered !== it.status;
      const attempts = changed
        ? it.attempts.map((a) =>
            a.outcome === 'running'
              ? {
                  ...a,
                  outcome: 'canceled' as const,
                  finishedAt: a.finishedAt ?? new Date(0).toISOString(),
                  error: '页面刷新，转换中断（未完成尝试不续跑）',
                }
              : a,
          )
        : it.attempts;
      const record: StoredBatchItem = {
        ...it,
        status: recovered,
        attempts,
        updatedAt: changed ? new Date().toISOString() : it.updatedAt,
      };
      itemRecords.set(record.id, record);
      if (changed) await idbPut(STORE_BATCH_ITEMS, record);
      (itemsByJob.get(record.jobId) ?? itemsByJob.set(record.jobId, []).get(record.jobId)!).push(record);
    }

    state.jobs = jobsStored
      .map((j): BatchJobView => {
        const items = (itemsByJob.get(j.id) ?? [])
          .map((r) => toView(r, false))
          .sort((a, b) => a.ordinal - b.ordinal);
        return {
          id: j.id,
          name: j.name,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
          defaults: {
            targetRefId: j.defaults.target?.refId ?? null,
            intent: j.defaults.intent,
            blackPointCompensation: j.defaults.blackPointCompensation,
            proofIntent: j.defaults.proofIntent,
          },
          canceledAll: j.canceledAll,
          items,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    state.activeJobId = state.jobs[0]?.id ?? null;
    state.ready = true;
    // Warm the worker so DEV test hooks (fault/delay) can be armed before the
    // first dispatch; the WASM instance is reused for all conversions.
    try {
      const { pingWorker } = await import('../workers/client');
      await pingWorker();
    } catch {
      /* worker initializes lazily on first conversion */
    }
    kickQueue(); // resumes only non-terminal items
  }

  // -------------------------------------------------------- item/job writes

  async function persistItem(record: StoredBatchItem, bytesLoaded = false) {
    itemRecords.set(record.id, record);
    await idbPut(STORE_BATCH_ITEMS, record);
    const job = jobView(record.jobId);
    if (job) {
      const idx = job.items.findIndex((i) => i.id === record.id);
      const next = toView(record, bytesLoaded);
      if (idx >= 0) job.items[idx] = next;
      else job.items.push(next);
      job.updatedAt = new Date().toISOString();
    }
  }

  async function persistJobMeta(
    job: BatchJobView,
    target?: FrozenProfile,
  ) {
    const stored = await idbGet<StoredBatchJob>(STORE_BATCH_JOBS, job.id);
    if (!stored) return;
    const next: StoredBatchJob = {
      ...stored,
      name: job.name,
      updatedAt: new Date().toISOString(),
      defaults: {
        target: target ?? stored.defaults.target,
        intent: job.defaults.intent,
        blackPointCompensation: job.defaults.blackPointCompensation,
        proofIntent: job.defaults.proofIntent,
      },
      canceledAll: job.canceledAll,
    };
    await idbPut(STORE_BATCH_JOBS, next);
  }

  // -------------------------------------------------------------- creation

  async function createJob(opts: {
    name: string;
    targetRefId: string | null;
    intent: RenderingIntent;
    blackPointCompensation: boolean;
    proofIntent: RenderingIntent;
  }): Promise<string> {
    const id = newId('job');
    const target = opts.targetRefId ? profiles.find((p) => p.id === opts.targetRefId) ?? null : null;
    const now = new Date().toISOString();
    const stored: StoredBatchJob = {
      id,
      name: opts.name || `批次 ${new Date().toLocaleString()}`,
      createdAt: now,
      updatedAt: now,
      defaults: {
        target: target ? frozenFromStoredProfile(target) : null,
        intent: opts.intent,
        blackPointCompensation: opts.blackPointCompensation,
        proofIntent: opts.proofIntent,
      },
      canceledAll: false,
    };
    await idbPut(STORE_BATCH_JOBS, stored);
    const view: BatchItemView[] = [];
    const jobViewObj: BatchJobView = $state({
      id,
      name: stored.name,
      createdAt: now,
      updatedAt: now,
      defaults: {
        targetRefId: opts.targetRefId,
        intent: opts.intent,
        blackPointCompensation: opts.blackPointCompensation,
        proofIntent: opts.proofIntent,
      },
      canceledAll: false,
      items: view,
    });
    state.jobs.unshift(jobViewObj);
    state.activeJobId = id;
    return id;
  }

  async function addFiles(
    jobId: string,
    files: File[],
  ): Promise<{ added: number; rejected: { name: string; reason: string }[] }> {
    const job = jobView(jobId);
    if (!job) return { added: 0, rejected: [] };
    let ordinal = job.items.length;
    const rejected: { name: string; reason: string }[] = [];

    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const container = detectContainer(bytes);
      if (container === 'unknown') {
        rejected.push({ name: file.name, reason: '仅支持 PNG / JPEG / WebP' });
        continue;
      }
      const provenance = detectProvenance(bytes);
      const guard = canAddToBatch(provenance.converted);
      if (!guard.ok) {
        rejected.push({ name: file.name, reason: guard.reason! });
        continue;
      }
      const embeddedBytes = extractEmbeddedICC(bytes);
      const embeddedInfo = embeddedBytes ? readProfileInfo(embeddedBytes) : null;
      const embedded = embeddedBytes && embeddedInfo?.valid ? frozenEmbedded(embeddedBytes) : null;

      // Embedded => freeze as effective source. Missing => source stays null;
      // item parks at needs-confirmation and CANNOT reach the queue.
      const source = embedded;
      const targetProfile = job.defaults.targetRefId
        ? profiles.find((p) => p.id === job.defaults.targetRefId) ?? null
        : null;
      const target = targetProfile ? frozenFromStoredProfile(targetProfile) : null;

      const id = newId('item');
      const now = new Date().toISOString();
      const record: StoredBatchItem = {
        id,
        jobId,
        createdAt: now,
        updatedAt: now,
        ordinal: ordinal++,
        imageBytes: bytes,
        imageName: file.name,
        container,
        bitDepth: container === 'png' && bytes[24] === 16 ? 16 : 8,
        width: null,
        height: null,
        pixelHash: fnv1a64(bytes),
        embeddedProfile: embedded ? { ...embedded } : null,
        provenanceConverted: false,
        source: source ? { ...source } : null,
        sourceIsAssumption: !embedded,
        target: target ? { ...target } : null,
        intent: job.defaults.intent,
        blackPointCompensation: job.defaults.blackPointCompensation,
        proofIntent: job.defaults.proofIntent,
        settingsRevision: 1,
        status: decideInitialStatus({ embedded: !!source, target: !!target }),
        attempts: [],
        successfulAttemptId: null,
        error: null,
      };
      await persistItem(record, true);
    }
    await persistJobMeta(job);
    kickQueue();
    return { added: files.length - rejected.length, rejected };
  }

  // ----------------------------------------------------- per-item settings

  /** Manually confirm the assumed source for an ICC-less original. */
  async function confirmSource(jobId: string, itemId: string, profileRefId: string) {
    const record = itemRecords.get(itemId);
    if (!record || record.jobId !== jobId) return;
    if (isSettingsLocked(record.status)) return;
    const p = profiles.find((x) => x.id === profileRefId);
    if (!p) throw new Error('配置库中找不到所选源配置');
    const frozen: FrozenProfile = { ...frozenFromStoredProfile(p), origin: 'manual-assumption' };
    const next = bumpSettings({ ...record, source: { ...frozen }, sourceIsAssumption: true });
    if (next.status === 'needs-confirmation' && isComplete(next)) next.status = 'queued';
    next.error = null;
    await persistItem(next, true);
    kickQueue();
  }

  /** Switch an embedded item's source to an explicit library assumption. */
  async function overrideEmbeddedSource(jobId: string, itemId: string, profileRefId: string | null) {
    const record = itemRecords.get(itemId);
    if (!record || record.jobId !== jobId) return;
    if (isSettingsLocked(record.status)) return;
    let next: StoredBatchItem;
    if (profileRefId === null) {
      if (!record.embeddedProfile) return;
      next = bumpSettings({ ...record, source: { ...record.embeddedProfile }, sourceIsAssumption: false });
    } else {
      const p = profiles.find((x) => x.id === profileRefId);
      if (!p) return;
      const frozen: FrozenProfile = { ...frozenFromStoredProfile(p), origin: 'manual-assumption' };
      next = bumpSettings({ ...record, source: { ...frozen }, sourceIsAssumption: true });
    }
    // A failed/canceled item whose settings are edited becomes queued again;
    // prior attempts remain in history.
    if (next.status === 'failed' || next.status === 'canceled') next.status = 'queued';
    await persistItem(next, true);
    kickQueue();
  }

  async function setTarget(jobId: string, itemId: string | null, profileRefId: string) {
    const p = profiles.find((x) => x.id === profileRefId);
    if (!p) return;
    const frozen = frozenFromStoredProfile(p);
    const job = jobView(jobId);
    if (!job) return;
    if (itemId === null) {
      job.defaults.targetRefId = profileRefId;
      await persistJobMeta(job, frozen);
      for (const view of [...job.items]) {
        const rec = itemRecords.get(view.id);
        if (!rec || isSettingsLocked(rec.status)) continue;
        const next = bumpSettings({ ...rec, target: { ...frozen } });
        if (next.status === 'needs-confirmation' && isComplete(next)) next.status = 'queued';
        else if (next.status === 'failed' || next.status === 'canceled') next.status = 'queued';
        await persistItem(next, true);
      }
    } else {
      const record = itemRecords.get(itemId);
      if (!record || record.jobId !== jobId || isSettingsLocked(record.status)) return;
      const next = bumpSettings({ ...record, target: { ...frozen } });
      if (next.status === 'needs-confirmation' && isComplete(next)) next.status = 'queued';
      else if (next.status === 'failed' || next.status === 'canceled') next.status = 'queued';
      await persistItem(next, true);
    }
    kickQueue();
  }

  async function setIntent(
    jobId: string,
    itemId: string | null,
    patch: { intent?: RenderingIntent; blackPointCompensation?: boolean; proofIntent?: RenderingIntent },
  ) {
    const job = jobView(jobId);
    if (!job) return;
    if (itemId === null) {
      Object.assign(job.defaults, patch);
      await persistJobMeta(job);
      for (const view of [...job.items]) {
        const rec = itemRecords.get(view.id);
        if (!rec || isSettingsLocked(rec.status)) continue;
        const next = bumpSettings({ ...rec, ...patch });
        if (next.status === 'needs-confirmation' && isComplete(next)) next.status = 'queued';
        else if (next.status === 'failed' || next.status === 'canceled') next.status = 'queued';
        await persistItem(next, true);
      }
    } else {
      const record = itemRecords.get(itemId);
      if (!record || record.jobId !== jobId || isSettingsLocked(record.status)) return;
      const next = bumpSettings({ ...record, ...patch });
      if (next.status === 'needs-confirmation' && isComplete(next)) next.status = 'queued';
      else if (next.status === 'failed' || next.status === 'canceled') next.status = 'queued';
      await persistItem(next, true);
    }
    kickQueue();
  }

  // ------------------------------------------------ queue/run/cancel/retry

  async function enqueue(jobId: string, itemId: string) {
    const record = itemRecords.get(itemId);
    if (!record || record.jobId !== jobId) return;
    const missing = missingConfirmations({
      embeddedProfile: record.embeddedProfile,
      source: record.source,
      target: record.target,
      intent: record.intent,
      blackPointCompensation: record.blackPointCompensation,
    });
    if (missing.length) {
      state.notice = `无法入队：${missing.join('、')} 尚未确认。`;
      return;
    }
    if (!canTransition(record.status, 'queued')) return;
    await persistItem(
      { ...record, status: 'queued', error: null, updatedAt: new Date().toISOString() },
      true,
    );
    kickQueue();
  }

  async function cancelItem(jobId: string, itemId: string) {
    let record = itemRecords.get(itemId);
    if (!record || record.jobId !== jobId) return;
    if (record.status === 'succeeded' || record.status === 'canceled') return;
    const flight = inFlight.get(itemId);
    if (flight) cancelConvert(flight.requestId);
    inFlight.delete(itemId);

    // Re-read so a result landing in the same tick cannot resurrect the item.
    const fresh = await idbGet<StoredBatchItem>(STORE_BATCH_ITEMS, itemId);
    record = fresh ?? record;
    if (record.status === 'succeeded' || record.status === 'canceled') {
      itemRecords.set(record.id, record);
      return;
    }
    const nowIso = new Date().toISOString();
    const attempts = flight
      ? record.attempts.map((a) =>
          a.id === flight.attemptId && a.outcome === 'running'
            ? { ...a, outcome: 'canceled' as const, finishedAt: nowIso, error: '操作员取消' }
            : a,
        )
      : record.attempts;
    await persistItem(
      {
        ...record,
        status: 'canceled',
        attempts,
        error: '操作员取消',
        updatedAt: nowIso,
      },
      true,
    );
  }

  /** Retry a failed/canceled item: appends a NEW attempt; history is kept. */
  async function retry(jobId: string, itemId: string) {
    let record = itemRecords.get(itemId);
    if (!record || record.jobId !== jobId) return;
    if (record.status !== 'failed' && record.status !== 'canceled') return;
    const fresh = await idbGet<StoredBatchItem>(STORE_BATCH_ITEMS, itemId);
    if (fresh) {
      record = fresh;
      itemRecords.set(record.id, fresh);
    }
    if (!isComplete(record)) {
      await persistItem(
        { ...record, status: 'needs-confirmation', updatedAt: new Date().toISOString() },
        true,
      );
      return;
    }
    // Other items' successes and this item's prior failures stay untouched.
    await persistItem(
      { ...record, status: 'queued', error: null, updatedAt: new Date().toISOString() },
      true,
    );
    kickQueue();
  }

  async function cancelJob(jobId: string) {
    const job = jobView(jobId);
    if (!job) return;
    job.canceledAll = true;
    await persistJobMeta(job);
    for (const item of [...job.items]) {
      if (item.status !== 'succeeded' && item.status !== 'canceled') {
        await cancelItem(jobId, item.id);
      }
    }
  }

  function kickQueue() {
    if (!state.ready || queueRunning) return;
    queueRunning = true;
    void drain().finally(() => (queueRunning = false));
  }

  /** One global FIFO across all jobs (oldest job, ordinal order). */
  async function drain() {
    for (;;) {
      const next = pickNext();
      if (!next) return;
      await runOne(next);
      // Small inter-item gap so cancel/reload windows are deterministic and
      // the UI can observe FIFO ordering.
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  function pickNext(): StoredBatchItem | null {
    const jobs = state.jobs.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of jobs) {
      if (job.canceledAll) continue;
      const queued = job.items
        .filter((i) => i.status === 'queued')
        .sort((a, b) => a.ordinal - b.ordinal);
      const candidate = queued[0];
      if (candidate) {
        const rec = itemRecords.get(candidate.id);
        if (rec && rec.status === 'queued') return rec;
      }
    }
    return null;
  }

  async function runOne(record: StoredBatchItem) {
    if (
      !record.source ||
      !record.target ||
      record.intent === null ||
      record.blackPointCompensation === null
    ) {
      await persistItem(
        { ...record, status: 'needs-confirmation', updatedAt: new Date().toISOString() },
        true,
      );
      return;
    }
    // Reload full frozen bytes from IDB (views drop them after refresh).
    const full = await idbGet<StoredBatchItem>(STORE_BATCH_ITEMS, record.id);
    if (!full) return;
    record = full;
    itemRecords.set(record.id, record);
    if (record.status !== 'queued') return; // canceled/changed while loading
    const srcProfile = record.source;
    const tgtProfile = record.target;
    const intent = record.intent;
    const bpc = record.blackPointCompensation;
    if (!srcProfile || !tgtProfile || intent === null || bpc === null) return;

    const attemptId = newId('att');
    const nowIso = new Date().toISOString();
    const revision = record.settingsRevision;
    const attempt: BatchAttempt = {
      id: attemptId,
      startedAt: nowIso,
      finishedAt: null,
      outcome: 'running',
      settings: {
        sourceRefId: srcProfile.refId,
        sourceOrigin: srcProfile.origin,
        targetRefId: tgtProfile.refId,
        intent,
        blackPointCompensation: bpc,
        settingsRevision: revision,
      },
      error: null,
      outputKey: null,
    };
    const running: StoredBatchItem = {
      ...record,
      status: 'converting',
      attempts: [...record.attempts, attempt],
      error: null,
      updatedAt: nowIso,
    };
    await persistItem(running, true);

    const token = runConvertToken({
      imageBytes: running.imageBytes,
      sourceIcc: srcProfile.bytes,
      targetIcc: tgtProfile.bytes,
      params: {
        intent,
        blackPointCompensation: bpc,
        proofIntent: running.proofIntent ?? 'relative-colorimetric',
      },
    });
    attempt.workerRequestId = token.requestId;
    await idbPut(STORE_BATCH_ITEMS, {
      ...running,
      attempts: running.attempts.map((a) => (a.id === attemptId ? { ...a, workerRequestId: token.requestId } : a)),
    });
    inFlight.set(running.id, {
      jobId: running.jobId,
      itemId: running.id,
      attemptId,
      requestId: token.requestId,
      settingsRevision: revision,
    });

    let result: ConvertedPayload | null = null;
    let runError: Error | null = null;
    try {
      result = await token.promise;
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
    }

    // Re-read current record: operator may have canceled/changed meanwhile.
    const current = (await idbGet<StoredBatchItem>(STORE_BATCH_ITEMS, running.id)) ?? running;
    itemRecords.set(current.id, current);
    const flight = inFlight.get(current.id);
    inFlight.delete(current.id);

    const rejection = acceptResultCheck({
      currentStatus: current.status,
      attemptId: flight?.attemptId ?? attemptId,
      responseAttemptId: attemptId,
      settingsRevision: current.settingsRevision,
      responseRevision: revision,
      successfulAttemptId: current.successfulAttemptId,
    });

    const finishedAt = new Date().toISOString();

    if (runError && runError.name === 'AbortError') {
      if (current.status === 'canceled') return; // cancelItem already recorded it
      await persistItem(
        {
          ...current,
          status: 'canceled',
          attempts: markRunning(current.attempts, attemptId, {
            outcome: 'canceled',
            error: '操作员取消',
          }),
          updatedAt: finishedAt,
        },
        true,
      );
      return;
    }

    if (rejection || runError || !result) {
      if (rejection && current.status !== 'converting') {
        // Late result against a canceled/terminal item: discard pixels entirely.
        return;
      }
      const error = rejection ?? runError?.message ?? '未知错误';
      await persistItem(
        {
          ...current,
          status: 'failed',
          attempts: current.attempts.map((a) =>
            a.id === attemptId
              ? finalizeAttempt(a, { outcome: 'failed', error, finishedAt })
              : a,
          ),
          error,
          updatedAt: finishedAt,
        },
        true,
      );
      return;
    }

    // Success: persist output + item atomically. Output key is unique per
    // attempt, so a retry's success can never overwrite a prior output.
    const outputKey = `${current.id}:${attemptId}`;
    if (await idbGet<StoredBatchOutput>(STORE_BATCH_OUTPUTS, outputKey)) return;
    const output: StoredBatchOutput = {
      key: outputKey,
      jobId: current.jobId,
      itemId: current.id,
      attemptId,
      createdAt: finishedAt,
      width: result.width,
      height: result.height,
      bitDepth: result.bitDepth,
      targetColorSpace: result.targetColorSpace,
      converted: result.converted,
      convertedColorChannels: result.convertedColorChannels,
      convertedChannels: result.convertedChannels,
      softProofRGBA: result.softProofRGBA,
      hasAlpha: result.hasAlpha,
    };
    const succeeded: StoredBatchItem = {
      ...current,
      status: 'succeeded',
      width: result.width,
      height: result.height,
      successfulAttemptId: attemptId,
      error: null,
      attempts: current.attempts.map((a) =>
        a.id === attemptId ? finalizeAttempt(a, { outcome: 'succeeded', outputKey, finishedAt }) : a,
      ),
      updatedAt: finishedAt,
    };
    await idbAtomicPut([
      { store: STORE_BATCH_ITEMS, value: succeeded },
      { store: STORE_BATCH_OUTPUTS, value: output },
    ]);
    itemRecords.set(succeeded.id, succeeded);
    const job = jobView(succeeded.jobId);
    if (job) {
      const idx = job.items.findIndex((i) => i.id === succeeded.id);
      if (idx >= 0) job.items[idx] = toView(succeeded, true);
      job.updatedAt = finishedAt;
    }
  }

  // --------------------------------------------------------------- outputs

  async function getOutput(itemId: string, attemptId: string): Promise<StoredBatchOutput | undefined> {
    return idbGet<StoredBatchOutput>(STORE_BATCH_OUTPUTS, `${itemId}:${attemptId}`);
  }

  async function deleteJob(jobId: string) {
    for (const it of await idbGetAllByIndex<StoredBatchItem>(STORE_BATCH_ITEMS, 'jobId', jobId)) {
      await idbDelete(STORE_BATCH_ITEMS, it.id);
      itemRecords.delete(it.id);
      for (const a of it.attempts) if (a.outputKey) await idbDelete(STORE_BATCH_OUTPUTS, a.outputKey);
    }
    await idbDelete(STORE_BATCH_JOBS, jobId);
    state.jobs = state.jobs.filter((j) => j.id !== jobId);
    if (state.activeJobId === jobId) state.activeJobId = state.jobs[0]?.id ?? null;
  }

  function selectJob(id: string) {
    state.activeJobId = id;
  }

  function clearNotice() {
    state.notice = '';
  }

  // ------------------------------------------------------------- helpers

  function isComplete(rec: StoredBatchItem): boolean {
    return (
      missingConfirmations({
        embeddedProfile: rec.embeddedProfile,
        source: rec.source,
        target: rec.target,
        intent: rec.intent,
        blackPointCompensation: rec.blackPointCompensation,
      }).length === 0
    );
  }

  function bumpSettings(rec: StoredBatchItem): StoredBatchItem {
    return { ...rec, settingsRevision: rec.settingsRevision + 1, updatedAt: new Date().toISOString() };
  }

  return {
    state,
    init,
    setProfiles,
    createJob,
    addFiles,
    confirmSource,
    overrideEmbeddedSource,
    setTarget,
    setIntent,
    enqueue,
    cancelItem,
    retry,
    cancelJob,
    kickQueue,
    getOutput,
    deleteJob,
    selectJob,
    clearNotice,
    profiles: () => profiles,
  };
}

function decideInitialStatus(opts: { embedded: boolean; target: boolean }): BatchItemStatus {
  if (!opts.embedded || !opts.target) return 'needs-confirmation';
  return 'queued';
}

function markRunning(
  attempts: BatchAttempt[],
  attemptId: string,
  patch: { outcome: BatchAttempt['outcome']; error?: string | null },
): BatchAttempt[] {
  const finishedAt = new Date().toISOString();
  return attempts.map((a) =>
    a.id === attemptId
      ? { ...a, outcome: patch.outcome, error: patch.error ?? a.error, finishedAt: a.finishedAt ?? finishedAt }
      : a,
  );
}

export type BatchManager = ReturnType<typeof createBatchManagerState>;

let singleton: BatchManager | null = null;
export function getBatch(): BatchManager {
  singleton ??= createBatchManagerState();
  return singleton;
}
