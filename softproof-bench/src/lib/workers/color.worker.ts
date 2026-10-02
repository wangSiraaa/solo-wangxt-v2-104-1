/// <reference lib="webworker" />
/**
 * Worker: owns the LittleCMS WASM instance and all pixel work.
 * Protocol (messages are plain structured-clone values):
 *
 *  -> { type: 'convert', id, imageBytes, sourceIcc, targetIcc, params }
 *  <-  { type: 'result', id, result? , error?, aborted? }
 *
 *  -> { type: 'sample', id, ... }
 *  <-  { type: 'sample-result', id, info?, error? }
 *
 *  -> { type: 'cancel', id }
 *      Cooperative cancellation: sets a flag checked between decode and each
 *      transform stage. A synchronous WASM transform cannot be interrupted, so
 *      the cancel takes effect at the next checkpoint; the (late) result is
 *      then posted as `aborted` and the main thread must discard it.
 *
 *  -> { type: '__test-set-fault', fault: string }  (DEV builds only)
 *      Next convert throws `fault` at its first checkpoint - used to exercise
 *      the failed -> retry path deterministically in E2E.
 *
 *  -> { type: '__test-set-delay', ms: number }      (DEV builds only)
 *      Each convert sleeps this long after decoding - used to keep an item
 *      in `converting` while the E2E reloads the page.
 *
 * Profiles and images arrive as ArrayBuffers (zero-copy transfer when sent
 * from the caller with a transfer list; here we clone to keep originals).
 */
import { decodeImage } from '../codec/decode';
import { convert, samplePixel } from '../color/engine';
import type { EngineParams } from '../color/engine';

declare const self: DedicatedWorkerGlobalScope;

export interface ConvertRequest {
  type: 'convert';
  id: number;
  imageBytes: ArrayBuffer;
  sourceIcc: ArrayBuffer;
  targetIcc: ArrayBuffer;
  params: EngineParams;
}
export interface SampleRequest {
  type: 'sample';
  id: number;
  imageBytes: ArrayBuffer;
  sourceIcc: ArrayBuffer;
  targetIcc: ArrayBuffer;
  params: EngineParams;
  x: number;
  y: number;
}
export interface CancelRequest {
  type: 'cancel';
  id: number;
}
export interface TestFaultRequest {
  type: '__test-set-fault';
  fault: string | null;
}
export interface TestDelayRequest {
  type: '__test-set-delay';
  ms: number;
}
export type WorkerRequest = ConvertRequest | SampleRequest | CancelRequest | TestFaultRequest | TestDelayRequest;

const abortFlags = new Map<number, boolean>();
let testFault: string | null = null;
let testDelay = 0;

function throwIfAborted(id: number) {
  if (abortFlags.get(id)) {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    abortFlags.set(msg.id, true);
    return;
  }
  if (msg.type === '__test-set-fault') {
    testFault = msg.fault;
    return;
  }
  if (msg.type === '__test-set-delay') {
    testDelay = msg.ms;
    return;
  }
  abortFlags.set(msg.id, false);
  try {
    const imageBytes = new Uint8Array(msg.imageBytes);
    const decoded = await decodeImage(imageBytes);
    throwIfAborted(msg.id);
    const profiles = {
      source: { bytes: new Uint8Array(msg.sourceIcc), description: 'source' },
      target: { bytes: new Uint8Array(msg.targetIcc), description: 'target' },
    };
    if (msg.type === 'convert') {
      if (testDelay > 0) {
        await new Promise((r) => setTimeout(r, testDelay));
      }
      throwIfAborted(msg.id);
      if (testFault) {
        const fault = testFault;
        testFault = null;
        throw new Error(fault);
      }
      const result = await convert(decoded, profiles, msg.params, () => throwIfAborted(msg.id));
      throwIfAborted(msg.id);
      self.postMessage(
        {
          type: 'result',
          id: msg.id,
          result: serialize(result),
        },
        transferableOf(result),
      );
    } else {
      const info = await samplePixel(decoded, profiles, msg.params, msg.x, msg.y);
      self.postMessage({ type: 'sample-result', id: msg.id, info });
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    self.postMessage({
      type: msg.type === 'sample' ? 'sample-result' : 'result',
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
      aborted,
    });
  } finally {
    abortFlags.delete(msg.id);
  }
};

function serialize(r: Awaited<ReturnType<typeof convert>>): {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  targetColorSpace: string;
  converted: ArrayBuffer;
  convertedColorChannels: 1 | 3 | 4;
  convertedChannels: number;
  softProofRGBA: ArrayBuffer;
  hasAlpha: boolean;
} {
  return {
    width: r.width,
    height: r.height,
    bitDepth: r.bitDepth,
    targetColorSpace: r.targetColorSpace,
    converted: bufferOf(r.converted),
    convertedColorChannels: r.convertedColorChannels,
    convertedChannels: r.convertedChannels,
    softProofRGBA: bufferOf(r.softProofRGBA),
    hasAlpha: r.hasAlpha,
  };
}

function bufferOf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}
function transferableOf(r: Awaited<ReturnType<typeof convert>>): ArrayBuffer[] {
  return [
    r.converted.buffer.slice(r.converted.byteOffset, r.converted.byteOffset + r.converted.byteLength) as ArrayBuffer,
    r.softProofRGBA.buffer.slice(
      r.softProofRGBA.byteOffset,
      r.softProofRGBA.byteOffset + r.softProofRGBA.byteLength,
    ) as ArrayBuffer,
  ];
}
