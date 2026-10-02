/**
 * Batch manifest ("批次清单"): the single JSON exported for a batch job.
 * Every converted output is associated with ITS OWN frozen settings record
 * and attempt id - outputs are never attributed to batch-level defaults.
 */
import type { RenderingIntent } from '../color/intents';
import { INTENT_VALUE } from '../color/intents';
import { RECORD_FORMAT, DISCLAIMER, type ProfileRef, type SourceAssumption } from '../color/record';
import type { FrozenProfile, BatchAttempt, BatchItemView } from './types';

export const BATCH_MANIFEST_FORMAT = 'softproof-bench-batch-manifest/1';
export const APP_NAME = 'softproof-bench';
export const APP_VERSION = '0.2.0';

export interface BatchManifestEntry {
  ordinal: number;
  itemId: string;
  attemptId: string;
  outputFile: string;
  source: ProfileRef;
  sourceAssumption: SourceAssumption;
  target: ProfileRef;
  transform: {
    intent: RenderingIntent;
    intentCode: number;
    blackPointCompensation: boolean;
    proofIntent: RenderingIntent;
    proofIntentCode: number;
  };
  image: {
    name: string;
    width: number | null;
    height: number | null;
    bitDepth: 8 | 16;
    container: string;
    pixelHash: string;
  };
  output: {
    kind: 'rgb-png' | 'gray-png' | 'cmyk-tiff';
    bitDepth: 8 | 16;
    targetColorSpace: string;
    embedsTargetICC: boolean;
  };
  attempt: {
    startedAt: string;
    finishedAt: string | null;
    failedHistory: { attemptId: string; error: string; finishedAt: string | null }[];
  };
}

export interface BatchManifest {
  manifestFormat: typeof BATCH_MANIFEST_FORMAT;
  recordFormat: typeof RECORD_FORMAT;
  createdAt: string;
  application: { name: typeof APP_NAME; version: string };
  batch: {
    jobId: string;
    name: string;
    itemCount: number;
    succeededCount: number;
  };
  disclaimer: string;
  entries: BatchManifestEntry[];
}

export function profileRefOfFrozen(p: FrozenProfile): ProfileRef {
  return {
    id: p.refId,
    description: p.description,
    colorSpace: p.colorSpace,
    origin: p.origin === 'manual-assumption' ? 'assumed' : p.origin === 'embedded' ? 'embedded' : p.origin === 'builtin-open' ? 'builtin' : 'user-library',
    profileId: p.profileId,
    byteLength: p.byteLength,
  };
}

export interface ManifestEntryInput {
  item: BatchItemView;
  attempt: BatchAttempt;
  outputFile: string;
  outputKind: BatchManifestEntry['output']['kind'];
  outputBitDepth: 8 | 16;
  targetColorSpace: string;
  proofIntent: RenderingIntent;
}

export function buildBatchManifest(
  job: { id: string; name: string },
  inputs: ManifestEntryInput[],
): BatchManifest {
  const now = new Date().toISOString();
  const entries: BatchManifestEntry[] = inputs
    .slice()
    .sort((a, b) => a.item.ordinal - b.item.ordinal)
    .map(({ item, attempt, outputFile, outputKind, outputBitDepth, targetColorSpace, proofIntent }) => {
      const source = item.source!;
      const target = item.target!;
      const intent = item.intent!;
      const bpc = item.blackPointCompensation!;
      const failedHistory = item.attempts
        .filter((a) => a.outcome === 'failed')
        .map((a) => ({ attemptId: a.id, error: a.error ?? '', finishedAt: a.finishedAt }));
      return {
        ordinal: item.ordinal,
        itemId: item.id,
        attemptId: attempt.id,
        outputFile,
        source: profileRefOfFrozen(source),
        sourceAssumption: {
          missingEmbedded: !item.embeddedProfile,
          assumedProfile: item.sourceIsAssumption ? profileRefOfFrozen(source) : undefined,
          note: item.sourceIsAssumption
            ? '原图缺少嵌入配置；由操作员在入队前人工确认该配置作为源空间假设。'
            : undefined,
        },
        target: profileRefOfFrozen(target),
        transform: {
          intent,
          intentCode: INTENT_VALUE[intent],
          blackPointCompensation: bpc,
          proofIntent,
          proofIntentCode: INTENT_VALUE[proofIntent],
        },
        image: {
          name: item.imageName,
          width: item.width,
          height: item.height,
          bitDepth: item.bitDepth,
          container: item.container,
          pixelHash: item.pixelHash,
        },
        output: {
          kind: outputKind,
          bitDepth: outputBitDepth,
          targetColorSpace,
          embedsTargetICC: true,
        },
        attempt: {
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt,
          failedHistory,
        },
      };
    });

  return {
    manifestFormat: BATCH_MANIFEST_FORMAT,
    recordFormat: RECORD_FORMAT,
    createdAt: now,
    application: { name: APP_NAME, version: APP_VERSION },
    batch: { jobId: job.id, name: job.name, itemCount: entries.length, succeededCount: entries.length },
    disclaimer: DISCLAIMER,
    entries,
  };
}
