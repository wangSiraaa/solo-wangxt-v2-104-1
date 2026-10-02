/**
 * Batch export: every succeeded item produces the same two artifacts as the
 * single-image flow (converted image + its own settings record), and the
 * batch itself gets a manifest ("批次清单") that ties each output file to the
 * settings record it was produced with. Failed/cancelled/pending entries are
 * listed with their status so the manifest is a complete account of the job.
 */
import { buildExport, type ExportedFiles } from '../codec/export';
import { DISCLAIMER, RECORD_FORMAT, type SettingsRecord } from '../color/record';
import { INTENT_VALUE } from '../color/lcms';
import { STATUS_LABEL, type StoredBatch, type StoredBatchItem } from './types';
import type { ConvertedPayload } from '../workers/client';

export const BATCH_MANIFEST_FORMAT = 'softproof-bench-batch/1';

/** Settings record for one item, built purely from its frozen settings. */
export function recordForItem(item: StoredBatchItem, appVersion: string): SettingsRecord {
  if (!item.source) throw new Error(`条目 ${item.name} 尚未确认源配置，无法生成设置记录`);
  if (!item.result) throw new Error(`条目 ${item.name} 尚无转换结果，无法生成设置记录`);
  const s = item.source;
  const t = item.target;
  return {
    recordFormat: RECORD_FORMAT,
    // The record documents the conversion, so it carries the conversion time.
    createdAt: item.result.finishedAt,
    application: { name: 'softproof-bench', version: appVersion },
    image: {
      name: item.name,
      width: item.result.width,
      height: item.result.height,
      bitDepth: item.result.bitDepth,
      container: item.container,
      pixelHash: item.imageHash,
    },
    source: {
      id: s.kind === 'embedded' ? `embedded:${item.imageHash}` : (s.profileId ?? 'unknown'),
      description: s.kind === 'embedded' ? `嵌入：${s.description}` : s.description,
      colorSpace: s.colorSpace,
      origin:
        s.kind === 'embedded'
          ? 'embedded'
          : s.profileId?.startsWith('builtin-')
            ? 'builtin'
            : 'user-library',
      byteLength: s.icc.byteLength,
    },
    sourceAssumption: {
      missingEmbedded: !item.embeddedIcc,
      assumedProfile:
        s.kind === 'assumed'
          ? {
              id: s.profileId ?? 'unknown',
              description: s.description,
              colorSpace: s.colorSpace,
              origin: s.profileId?.startsWith('builtin-') ? 'builtin' : 'user-library',
              byteLength: s.icc.byteLength,
            }
          : undefined,
      note: s.assumptionNote,
    },
    target: {
      id: t.targetProfileId,
      description: t.targetDescription,
      colorSpace: t.targetColorSpace,
      origin: t.targetProfileId.startsWith('builtin-') ? 'builtin' : 'user-library',
      byteLength: t.targetIcc.byteLength,
    },
    transform: {
      intent: t.intent,
      intentCode: INTENT_VALUE[t.intent],
      blackPointCompensation: t.blackPointCompensation,
      proofIntent: t.proofIntent,
      proofIntentCode: INTENT_VALUE[t.proofIntent],
    },
    // filled by buildExport
    export: { kind: 'rgb-png', bitDepth: item.result.bitDepth, embedsTargetICC: true, fileName: '' },
    disclaimer: DISCLAIMER,
  };
}

function payloadOf(item: StoredBatchItem): ConvertedPayload {
  const r = item.result!;
  return {
    width: r.width,
    height: r.height,
    bitDepth: r.bitDepth,
    targetColorSpace: r.targetColorSpace,
    converted: r.converted,
    convertedColorChannels: r.convertedColorChannels,
    convertedChannels: r.convertedChannels,
    softProofRGBA: r.softProofRGBA,
    hasAlpha: r.hasAlpha,
  };
}

export interface BatchExportEntry {
  itemId: string;
  itemName: string;
  status: StoredBatchItem['status'];
  statusLabel: string;
  imageHash: string;
  output?: {
    fileName: string;
    kind: SettingsRecord['export']['kind'];
    /** The settings record file that belongs to this output. */
    settingsRecordFile: string;
    finishedAt: string;
    attemptId: string;
  };
  lastError?: string;
  attempts: { id: string; startedAt: string; finishedAt?: string; outcome?: string; error?: string }[];
}

export interface BatchManifest {
  manifestFormat: typeof BATCH_MANIFEST_FORMAT;
  exportedAt: string;
  application: { name: 'softproof-bench'; version: string };
  batch: { id: string; name: string; createdAt: string };
  recordFormat: typeof RECORD_FORMAT;
  entries: BatchExportEntry[];
  disclaimer: string;
}

export interface BatchExportFiles {
  manifest: { name: string; bytes: Uint8Array };
  /** Per-item artifacts, in item order: image + settings record per succeeded item. */
  files: { name: string; bytes: Uint8Array; mime: string }[];
  entries: BatchExportEntry[];
}

/**
 * Encode every succeeded item (image + settings JSON) and assemble the
 * manifest. Item order follows the batch sequence.
 */
export async function buildBatchExport(
  batch: StoredBatch,
  items: StoredBatchItem[],
  appVersion: string,
): Promise<BatchExportFiles> {
  const files: BatchExportFiles['files'] = [];
  const entries: BatchExportEntry[] = [];
  const ordered = [...items].sort((a, b) => a.seq - b.seq);

  for (const item of ordered) {
    const base: BatchExportEntry = {
      itemId: item.id,
      itemName: item.name,
      status: item.status,
      statusLabel: STATUS_LABEL[item.status],
      imageHash: item.imageHash,
      lastError: item.lastError || undefined,
      attempts: item.attempts.map((a) => ({
        id: a.id,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
        outcome: a.outcome,
        error: a.error,
      })),
    };
    if (item.status === 'succeeded' && item.result && item.source) {
      const record = recordForItem(item, appVersion);
      const baseName = item.name.replace(/\.[^.]+$/, '') || item.id;
      const exported: ExportedFiles = await buildExport({
        converted: payloadOf(item),
        targetIcc: item.target.targetIcc,
        targetIccName: item.target.targetDescription,
        baseName,
        record,
      });
      files.push({ name: exported.image.name, bytes: exported.image.bytes, mime: exported.image.mime });
      files.push({ name: exported.json.name, bytes: exported.json.bytes, mime: 'application/json' });
      base.output = {
        fileName: exported.image.name,
        kind: record.export.kind,
        settingsRecordFile: exported.json.name,
        finishedAt: item.result.finishedAt,
        attemptId: item.result.attemptId,
      };
    }
    entries.push(base);
  }

  const manifest: BatchManifest = {
    manifestFormat: BATCH_MANIFEST_FORMAT,
    exportedAt: new Date().toISOString(),
    application: { name: 'softproof-bench', version: appVersion },
    batch: { id: batch.id, name: batch.name, createdAt: batch.createdAt },
    recordFormat: RECORD_FORMAT,
    entries,
    disclaimer: DISCLAIMER,
  };
  const safeName = batch.name.replace(/[^a-zA-Z0-9_一-鿿-]+/g, '_').slice(0, 60) || 'batch';
  return {
    manifest: {
      name: `${safeName}.batch-manifest.json`,
      bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    },
    files,
    entries,
  };
}
