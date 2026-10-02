/**
 * Batch proofing ("批次打样作业") domain types.
 *
 * Discipline enforced by these types:
 *  - Every item FREEZES the original master bytes and the exact settings a
 *    conversion ran with (source/profile provenance, target, intent, BPC).
 *    Nothing is guessed: items without an embedded ICC and without an explicit
 *    operator assumption stay `needs-confirmation` and never reach the queue.
 *  - Each conversion is an ATTEMPT. Retries append a new attempt; failed and
 *    cancelled attempts (and other items' successes) are never overwritten.
 *  - Items are keyed by their own id, never merged - identical pixel files with
 *    different manual assumptions are different items.
 */
import type { RenderingIntent } from '../color/intents';
import type { ColorSpaceKind } from '../icc/profileInfo';

export type BatchItemStatus =
  | 'needs-confirmation' // 待确认：源配置未明确（无嵌入且未人工选择）
  | 'queued' // 排队
  | 'converting' // 转换中
  | 'succeeded' // 成功（终态）
  | 'failed' // 失败（终态，可重试为新尝试）
  | 'canceled'; // 已取消（终态）

export const TERMINAL_STATUSES: ReadonlySet<BatchItemStatus> = new Set([
  'succeeded',
  'failed',
  'canceled',
]);

export const STATUS_LABEL: Record<BatchItemStatus, string> = {
  'needs-confirmation': '待确认',
  queued: '排队',
  converting: '转换中',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
};

/** Frozen profile snapshot embedded into the item at enqueue time. */
export interface FrozenProfile {
  /**
   * - `embedded:<profileId>` for the ICC carried inside the original file;
   * - profiles-store id when taken from the local library (builtin/user).
   */
  refId: string;
  description: string;
  colorSpace: ColorSpaceKind;
  origin: 'embedded' | 'builtin-open' | 'user-imported' | 'manual-assumption';
  /** Full profile bytes frozen at decision time. */
  bytes: Uint8Array;
  byteLength: number;
  profileId?: string;
}

export type AttemptOutcome = 'running' | 'succeeded' | 'failed' | 'canceled';

export interface BatchAttempt {
  id: string;
  /** Worker request id this attempt was dispatched under (main-thread bookkeeping). */
  workerRequestId?: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: AttemptOutcome;
  /** Settings snapshot the conversion actually used. */
  settings: {
    sourceRefId: string;
    sourceOrigin: FrozenProfile['origin'];
    targetRefId: string;
    intent: RenderingIntent;
    blackPointCompensation: boolean;
    settingsRevision: number;
  };
  error: string | null;
  outputKey: string | null;
}

/** In-memory item: bytes are loaded lazily from IndexedDB when converting. */
export interface BatchItemView {
  id: string;
  jobId: string;
  createdAt: string;
  updatedAt: string;
  ordinal: number;
  imageName: string;
  container: string;
  bitDepth: 8 | 16;
  width: number | null;
  height: number | null;
  pixelHash: string;
  embeddedProfile: FrozenProfile | null;
  provenanceConverted: boolean;
  source: FrozenProfile | null;
  sourceIsAssumption: boolean;
  target: FrozenProfile | null;
  intent: RenderingIntent | null;
  blackPointCompensation: boolean | null;
  proofIntent: RenderingIntent | null;
  settingsRevision: number;
  status: BatchItemStatus;
  attempts: BatchAttempt[];
  successfulAttemptId: string | null;
  error: string | null;
  /** true when byte-level original/embedded snapshot is held in memory. */
  bytesLoaded: boolean;
}

export interface BatchJobView {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  defaults: {
    targetRefId: string | null;
    intent: RenderingIntent;
    blackPointCompensation: boolean;
    proofIntent: RenderingIntent;
  };
  canceledAll: boolean;
  items: BatchItemView[];
}
