/**
 * Batch export: every SUCCEEDED item is exported as its own converted image
 * (target ICC embedded + provenance marker) PLUS one batch manifest JSON that
 * associates each output file with the item's OWN frozen settings and attempt
 * history. Batch-level defaults are never used to describe an output.
 */
import { encodePng } from '../codec/png';
import { encodeTiffCmyk } from '../codec/tiff';
import { PROVENANCE_KEY } from '../color/record';
import type { StoredBatchItem, StoredBatchJob, StoredBatchOutput } from '../db/db';
import {
  buildBatchManifest,
  profileRefOfFrozen,
  type BatchManifest,
  type BatchManifestEntry,
} from './manifest';
import type { BatchItemView } from './types';

export interface BatchExportFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export interface BatchExportResult {
  files: BatchExportFile[];
  manifest: BatchManifest;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'item';
}

function baseNameOf(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'image';
}

export function outputKindOf(o: StoredBatchOutput): BatchManifestEntry['output']['kind'] {
  if (o.targetColorSpace === 'CMYK') return 'cmyk-tiff';
  return o.targetColorSpace === 'GRAY' ? 'gray-png' : 'rgb-png';
}

function encodeOutputImage(item: StoredBatchItem, o: StoredBatchOutput): BatchExportFile {
  const target = item.target!;
  const provenance = JSON.stringify({
    key: PROVENANCE_KEY,
    batchItem: item.id,
    attempt: o.attemptId,
    source: profileRefOfFrozen(item.source!).id,
    target: target.refId,
    intent: item.intent,
    bpc: item.blackPointCompensation,
    convertedNotOriginal: true,
  });
  const base = `${String(item.ordinal + 1).padStart(3, '0')}-${sanitize(baseNameOf(item.imageName))}`;

  if (o.targetColorSpace === 'CMYK') {
    const srcCh = o.convertedChannels; // 4 or 5 with alpha
    const hasAlpha = o.hasAlpha && srcCh === 5;
    const cmyk = new Uint8Array(o.width * o.height * 4);
    for (let i = 0; i < o.width * o.height; i++) {
      if (hasAlpha && o.converted[i * srcCh + 4] === 0) continue;
      for (let c = 0; c < 4; c++) cmyk[i * 4 + c] = o.converted[i * srcCh + c];
    }
    const bytes = encodeTiffCmyk({
      width: o.width,
      height: o.height,
      data: cmyk,
      channels: 4,
      icc: target.bytes,
      description: provenance,
    });
    return { name: `${base}.proof-${sanitize(target.refId)}.tif`, bytes, mime: 'image/tiff' };
  }

  const colorChannels: 1 | 3 = o.targetColorSpace === 'GRAY' ? 1 : 3;
  const bytes = encodePng({
    width: o.width,
    height: o.height,
    colorChannels,
    bitDepth: o.bitDepth,
    data: o.converted,
    hasAlpha: o.hasAlpha,
    icc: target.bytes,
    iccName: target.description,
    text: {
      [PROVENANCE_KEY]: provenance,
      'Source-Profile': `${item.source!.description} (${item.source!.origin})`.slice(0, 7900),
      'Target-Profile': target.description.slice(0, 7900),
      'Batch-Item': item.id,
      'Attempt': o.attemptId,
    },
  });
  return { name: `${base}.proof-${sanitize(target.refId)}.png`, bytes, mime: 'image/png' };
}

/**
 * Build all export artifacts for a job. `views` carry the metadata; full
 * records + outputs are read from IDB by the caller and passed in.
 */
export function buildBatchExport(
  job: StoredBatchJob,
  records: StoredBatchItem[],
  outputs: StoredBatchOutput[],
  views: BatchItemView[],
): BatchExportResult {
  const outputByKey = new Map(outputs.map((o) => [o.key, o]));
  const files: BatchExportFile[] = [];
  const manifestInputs: Parameters<typeof buildBatchManifest>[1] = [];

  const sorted = records
    .filter((r) => r.status === 'succeeded' && r.successfulAttemptId)
    .sort((a, b) => a.ordinal - b.ordinal);

  for (const item of sorted) {
    const output = outputByKey.get(`${item.id}:${item.successfulAttemptId}`);
    if (!output || !item.source || !item.target) continue;
    const image = encodeOutputImage(item, output);
    files.push(image);
    const view = views.find((v) => v.id === item.id);
    const attempt = item.attempts.find((a) => a.id === item.successfulAttemptId)!;
    manifestInputs.push({
      item: view ?? viewFromRecord(item),
      attempt,
      outputFile: image.name,
      outputKind: outputKindOf(output),
      outputBitDepth: output.bitDepth,
      targetColorSpace: output.targetColorSpace,
      proofIntent: item.proofIntent ?? 'relative-colorimetric',
    });
  }

  const manifest = buildBatchManifest({ id: job.id, name: job.name }, manifestInputs);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  files.push({
    name: `${sanitize(job.name) || 'batch'}.batch-manifest.json`,
    bytes: manifestBytes,
    mime: 'application/json',
  });
  return { files, manifest };
}

function viewFromRecord(r: StoredBatchItem): BatchItemView {
  return {
    id: r.id,
    jobId: r.jobId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ordinal: r.ordinal,
    imageName: r.imageName,
    container: r.container,
    bitDepth: r.bitDepth,
    width: r.width,
    height: r.height,
    pixelHash: r.pixelHash,
    embeddedProfile: r.embeddedProfile,
    provenanceConverted: r.provenanceConverted,
    source: r.source,
    sourceIsAssumption: r.sourceIsAssumption,
    target: r.target,
    intent: r.intent,
    blackPointCompensation: r.blackPointCompensation,
    proofIntent: r.proofIntent,
    settingsRevision: r.settingsRevision,
    status: r.status,
    attempts: r.attempts,
    successfulAttemptId: r.successfulAttemptId,
    error: r.error,
    bytesLoaded: true,
  };
}
