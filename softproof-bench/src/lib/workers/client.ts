/**
 * Main-thread client for the color worker. Requests keep the original image
 * and profile bytes in memory; transferred buffers are copies so the saved
 * project is never detached.
 */
import ColorWorker from './color.worker.ts?worker';
import type { EngineParams, SampleInfo } from '../color/engine';
import type { ColorSpaceKind } from '../icc/profileInfo';

export interface ConvertedPayload {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  targetColorSpace: ColorSpaceKind;
  converted: Uint8Array;
  convertedColorChannels: 1 | 3 | 4;
  convertedChannels: number;
  softProofRGBA: Uint8Array;
  hasAlpha: boolean;
}

/** Distinguishable rejection produced by cancelTask (and worker-side aborts). */
export class TaskCancelledError extends Error {
  constructor(message = '任务已取消') {
    super(message);
    this.name = 'TaskCancelled';
  }
}
export const isTaskCancelled = (e: unknown): boolean =>
  e instanceof TaskCancelledError || (e instanceof Error && e.name === 'TaskCancelled');

export interface ConvertHandle {
  /** Worker task id, stable for the whole life of the request. */
  id: number;
  promise: Promise<ConvertedPayload>;
}

let worker: Worker | null = null;
let seq = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (!worker) {
    worker = new ColorWorker();
    worker.onmessage = (ev: MessageEvent) => {
      const { id, error } = ev.data;
      const p = pending.get(id);
      // Unknown id: the task was cancelled (or already settled) — its late
      // reply is dropped here and can never reach a caller.
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else if (ev.data.cancelled) p.reject(new TaskCancelledError());
      else if (ev.data.type === 'result') p.resolve(toConverted(ev.data.result));
      else p.resolve(ev.data.info as SampleInfo);
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || '色彩工作线程错误');
      pending.forEach((p) => p.reject(err));
      pending.clear();
    };
  }
  return worker;
}

function copy(buf: ArrayBuffer): ArrayBuffer {
  return buf.slice(0);
}

function toConverted(r: {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  targetColorSpace: ColorSpaceKind;
  converted: ArrayBuffer;
  convertedColorChannels: 1 | 3 | 4;
  convertedChannels: number;
  softProofRGBA: ArrayBuffer;
  hasAlpha: boolean;
}): ConvertedPayload {
  return {
    width: r.width,
    height: r.height,
    bitDepth: r.bitDepth,
    targetColorSpace: r.targetColorSpace,
    converted: new Uint8Array(r.converted),
    convertedColorChannels: r.convertedColorChannels,
    convertedChannels: r.convertedChannels,
    softProofRGBA: new Uint8Array(r.softProofRGBA),
    hasAlpha: r.hasAlpha,
  };
}

/**
 * Post a convert request and return its task id immediately, so callers
 * (the batch runner) can persist the id before the work finishes and can
 * cancel this exact task later.
 */
export function startConvert(opts: {
  imageBytes: Uint8Array;
  sourceIcc: Uint8Array;
  targetIcc: Uint8Array;
  params: EngineParams;
}): ConvertHandle {
  const w = ensureWorker();
  const id = seq++;
  const payload = {
    type: 'convert' as const,
    id,
    imageBytes: copy(ab(opts.imageBytes)),
    sourceIcc: copy(ab(opts.sourceIcc)),
    targetIcc: copy(ab(opts.targetIcc)),
    params: opts.params,
  };
  const promise = new Promise<ConvertedPayload>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage(payload, [payload.imageBytes, payload.sourceIcc, payload.targetIcc]);
  });
  return { id, promise };
}

export function runConvert(opts: {
  imageBytes: Uint8Array;
  sourceIcc: Uint8Array;
  targetIcc: Uint8Array;
  params: EngineParams;
}): Promise<ConvertedPayload> {
  return startConvert(opts).promise;
}

/**
 * Cancel a running/queued task: its promise rejects with TaskCancelledError
 * and the worker is told to drop the task at its next checkpoint. A result
 * that still arrives afterwards has no pending entry and is discarded.
 */
export function cancelTask(id: number): void {
  const p = pending.get(id);
  if (p) {
    pending.delete(id);
    p.reject(new TaskCancelledError());
  }
  worker?.postMessage({ type: 'cancel', id });
}

export function runSample(opts: {
  imageBytes: Uint8Array;
  sourceIcc: Uint8Array;
  targetIcc: Uint8Array;
  params: EngineParams;
  x: number;
  y: number;
}): Promise<SampleInfo> {
  const w = ensureWorker();
  const id = seq++;
  const payload = {
    type: 'sample' as const,
    id,
    imageBytes: copy(ab(opts.imageBytes)),
    sourceIcc: copy(ab(opts.sourceIcc)),
    targetIcc: copy(ab(opts.targetIcc)),
    params: opts.params,
    x: opts.x,
    y: opts.y,
  };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage(payload, [payload.imageBytes, payload.sourceIcc, payload.targetIcc]);
  });
}

function ab(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}
