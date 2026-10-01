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

let worker: Worker | null = null;
let seq = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (!worker) {
    worker = new ColorWorker();
    worker.onmessage = (ev: MessageEvent) => {
      const { id, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
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

export function runConvert(opts: {
  imageBytes: Uint8Array;
  sourceIcc: Uint8Array;
  targetIcc: Uint8Array;
  params: EngineParams;
}): Promise<ConvertedPayload> {
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
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage(payload, [payload.imageBytes, payload.sourceIcc, payload.targetIcc]);
  });
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
