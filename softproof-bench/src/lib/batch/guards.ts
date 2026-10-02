/**
 * Pure state-machine + race guards for batch proofing. No DOM, no IndexedDB,
 * no Svelte - directly unit-testable in Node.
 *
 * The central problem: worker results are asynchronous. A result must be
 * accepted ONLY when it still matches what the item currently is:
 *
 *  - same attempt id (retries create new attempts; old results find no owner),
 *  - same settings revision (editing frozen settings bumps the revision),
 *  - item is still `converting` (canceled/terminal items reject late results),
 *  - no prior success exists (succeeded outputs are never regenerated/replaced).
 */
import { TERMINAL_STATUSES, type BatchItemStatus, type BatchAttempt } from './types';

export function isTerminal(status: BatchItemStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * After a page refresh an item can only be persisted as `converting` while a
 * worker was mid-flight. The worker is gone, so the item must be resumed -
 * terminal items (incl. finished outputs) are left untouched.
 */
export function recoverStatus(status: BatchItemStatus): BatchItemStatus {
  return status === 'converting' ? 'queued' : status;
}

/**
 * Decide whether a (possibly late) conversion result may be applied.
 * Returns null when accepted, otherwise a human-readable rejection reason.
 */
export function acceptResultCheck(opts: {
  currentStatus: BatchItemStatus;
  attemptId: string;
  responseAttemptId: string;
  settingsRevision: number;
  responseRevision: number;
  successfulAttemptId: string | null;
}): string | null {
  if (opts.currentStatus !== 'converting') {
    return `条目当前状态为 ${opts.currentStatus}，迟到结果（尝试 ${opts.responseAttemptId}）已丢弃`;
  }
  if (opts.attemptId !== opts.responseAttemptId) {
    return `结果属于旧尝试 ${opts.responseAttemptId}，当前尝试为 ${opts.attemptId}，已丢弃`;
  }
  if (opts.settingsRevision !== opts.responseRevision) {
    return `结果基于已更改的配置（revision ${opts.responseRevision} → ${opts.settingsRevision}），已丢弃`;
  }
  if (opts.successfulAttemptId) {
    return `条目已有成功输出（尝试 ${opts.successfulAttemptId}），拒绝重复生成`;
  }
  return null;
}

/** Whether a freshly imported file may join a batch as a new original. */
export function canAddToBatch(provenanceConverted: boolean): { ok: boolean; reason?: string } {
  if (provenanceConverted) {
    return {
      ok: false,
      reason: '该文件带有本工具的“已转换”标记，不能作为批次原图（防止二次转换）。',
    };
  }
  return { ok: true };
}

/**
 * Frozen settings a conversion needs. Null/undefined fields keep the item in
 * `needs-confirmation` - silently assuming a source profile is forbidden.
 */
export function missingConfirmations(opts: {
  embeddedProfile: unknown | null;
  source: unknown | null;
  target: unknown | null;
  intent: unknown | null;
  blackPointCompensation: unknown | null;
}): string[] {
  const missing: string[] = [];
  if (!opts.embeddedProfile && !opts.source) missing.push('源配置（图片无嵌入 ICC，必须人工确认）');
  if (opts.embeddedProfile && !opts.source) missing.push('源配置快照');
  if (!opts.target) missing.push('目标配置');
  if (!opts.intent) missing.push('渲染意图');
  if (opts.blackPointCompensation === null) missing.push('黑点补偿');
  return missing;
}

export type AttemptResult =
  | { outcome: 'succeeded'; outputKey: string; finishedAt: string }
  | { outcome: 'failed'; error: string; finishedAt: string }
  | { outcome: 'canceled'; finishedAt: string };

/** Return a NEW updated attempt object; the history is never mutated in place. */
export function finalizeAttempt(attempt: BatchAttempt, result: AttemptResult): BatchAttempt {
  return {
    ...attempt,
    finishedAt: result.finishedAt,
    outcome: result.outcome,
    error: result.outcome === 'failed' ? result.error : null,
    outputKey: result.outcome === 'succeeded' ? result.outputKey : attempt.outputKey,
  };
}

/** Allowed status transitions (queue/run control, editing, retry/cancel). */
const TRANSITIONS: Record<BatchItemStatus, BatchItemStatus[]> = {
  'needs-confirmation': ['queued', 'canceled'],
  queued: ['converting', 'canceled', 'needs-confirmation'],
  converting: ['succeeded', 'failed', 'canceled'],
  failed: ['queued', 'canceled'],
  canceled: ['queued'],
  succeeded: [],
};

export function canTransition(from: BatchItemStatus, to: BatchItemStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
