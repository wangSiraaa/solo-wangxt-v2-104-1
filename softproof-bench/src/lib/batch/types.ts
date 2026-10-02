/**
 * Batch proofing jobs ("批次打样作业") — data model and pure helpers.
 *
 * A print shop drops several originals of the same layout; each becomes one
 * batch item that freezes everything the conversion depends on:
 *
 *  - the original image bytes (never re-read, never replaced)
 *  - the source profile decision: the embedded ICC, or a manually confirmed
 *    ("assumed") library profile — both frozen as bytes, not references
 *  - the target press profile (frozen bytes + identity)
 *  - rendering intent, black point compensation, soft-proof intent
 *
 * Items persist with a status lifecycle:
 *
 *    pending-confirm ──confirm──▶ queued ──pump──▶ converting ──▶ succeeded
 *                       ▲              │               │  └─────▶ failed ──retry──▶ queued
 *                       │              ▼               ▼
 *                       └──────── cancelled ◀──────────┘
 *
 * succeeded / failed / cancelled are terminal; queued/converting are the only
 * states the runner picks up, and a refresh demotes a stale `converting` back
 * to `queued` (the attempt is closed as interrupted) so only unfinished work
 * resumes — finished outputs are never regenerated.
 */
import type { RenderingIntent } from '../color/lcms';
import type { ColorSpaceKind } from '../icc/profileInfo';
import { fnv1a64 } from '../color/hash';

export type BatchItemStatus =
  | 'pending-confirm'
  | 'queued'
  | 'converting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export const STATUS_LABEL: Record<BatchItemStatus, string> = {
  'pending-confirm': '待确认',
  queued: '排队中',
  converting: '转换中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

export const isTerminal = (s: BatchItemStatus): boolean =>
  s === 'succeeded' || s === 'failed' || s === 'cancelled';

/** Source decision frozen into an item. Bytes travel with the item. */
export interface BatchSourceSettings {
  kind: 'embedded' | 'assumed';
  /** Library profile id when assumed; null for embedded. */
  profileId: string | null;
  description: string;
  colorSpace: ColorSpaceKind;
  /** Frozen ICC bytes (embedded profile or the chosen library profile). */
  icc: Uint8Array;
  /** Recorded when the operator had to assume (no embedded profile). */
  assumptionNote?: string;
}

/** Target + transform parameters frozen into an item at add/confirm time. */
export interface BatchTargetSettings {
  targetProfileId: string;
  targetDescription: string;
  targetColorSpace: ColorSpaceKind;
  /** Frozen ICC bytes of the press profile. */
  targetIcc: Uint8Array;
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  proofIntent: RenderingIntent;
}

export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';

export interface BatchAttempt {
  id: string;
  /** Worker task id (client.ts sequence) once the task is posted. */
  taskId: number | null;
  startedAt: string;
  finishedAt?: string;
  outcome?: AttemptOutcome;
  error?: string;
  /** Settings signature this attempt ran with — stale results are dropped
   *  when the item's current key no longer matches. */
  settingsKey: string;
}

export interface BatchItemResult {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  targetColorSpace: ColorSpaceKind;
  converted: Uint8Array;
  convertedColorChannels: 1 | 3 | 4;
  convertedChannels: number;
  softProofRGBA: Uint8Array;
  hasAlpha: boolean;
  attemptId: string;
  settingsKey: string;
  finishedAt: string;
}

export interface StoredBatchItem {
  id: string;
  batchId: string;
  /** Position within the batch (import order). */
  seq: number;
  name: string;
  addedAt: string;
  updatedAt: string;
  status: BatchItemStatus;
  /** Frozen original bytes — the only pixels ever converted. */
  imageBytes: Uint8Array;
  imageHash: string;
  container: string;
  bitDepth: 8 | 16;
  /** Embedded ICC as found at import (informational; also the frozen source
   *  when source.kind === 'embedded'). */
  embeddedIcc: Uint8Array | null;
  /** Frozen target/params (set at add time). */
  target: BatchTargetSettings;
  /** Frozen source decision; null while pending-confirm. */
  source: BatchSourceSettings | null;
  /** imageHash + settings signature; '' until the source is confirmed. */
  settingsKey: string;
  /** Attempt currently running (status === 'converting'), else null. */
  activeAttemptId: string | null;
  activeTaskId: number | null;
  attempts: BatchAttempt[];
  result: BatchItemResult | null;
  lastError: string;
}

export interface StoredBatch {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Defaults stamped onto items added afterwards; existing items keep their
   *  own frozen copies. */
  defaults: {
    targetProfileId: string | null;
    intent: RenderingIntent;
    blackPointCompensation: boolean;
    proofIntent: RenderingIntent;
  };
}

/**
 * Signature of everything that determines the converted output. Two entries
 * are the "same job" only when bytes AND every frozen setting match — the
 * same pixel file queued under two different manual assumptions yields two
 * different keys and must never be merged.
 */
export function settingsKeyOf(
  imageHash: string,
  source: BatchSourceSettings,
  target: BatchTargetSettings,
): string {
  return [
    imageHash,
    source.kind,
    source.profileId ?? 'embedded',
    fnv1a64(source.icc),
    target.targetProfileId,
    fnv1a64(target.targetIcc),
    target.intent,
    target.blackPointCompensation ? 'bpc1' : 'bpc0',
    target.proofIntent,
  ].join('|');
}

/**
 * Transition applied at load time to items the previous session left behind.
 * A persisted `converting` cannot still be running (its worker died with the
 * page), so it is demoted to `queued` and its attempt closed as interrupted;
 * terminal states and `pending-confirm` pass through untouched.
 */
export function recoveryTransition(item: StoredBatchItem, now: string): StoredBatchItem {
  if (item.status !== 'converting') return item;
  const attempts = item.attempts.map((a) =>
    a.id === item.activeAttemptId && !a.outcome
      ? { ...a, finishedAt: now, outcome: 'cancelled' as AttemptOutcome, error: '页面刷新或关闭，转换中断' }
      : a,
  );
  return {
    ...item,
    status: 'queued',
    activeAttemptId: null,
    activeTaskId: null,
    attempts,
    updatedAt: now,
  };
}
