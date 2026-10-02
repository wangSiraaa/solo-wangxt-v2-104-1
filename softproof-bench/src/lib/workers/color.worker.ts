/// <reference lib="webworker" />
/**
 * Worker: owns the LittleCMS WASM instance and all pixel work.
 * Protocol (messages are plain structured-clone values):
 *
 *  -> { type: 'convert', id, imageBytes, sourceIcc, targetIcc, params }
 *  <-  { type: 'result', id, result? , error?, cancelled? }
 *
 *  -> { type: 'sample', id, imageBytes, sourceIcc, targetIcc, params, x, y }
 *  <-  { type: 'sample-result', id, info?, error? }
 *
 *  -> { type: 'cancel', id }   (no reply guaranteed)
 *
 * Profiles and images arrive as ArrayBuffers (zero-copy transfer when sent
 * from the caller with a transfer list; here we clone to keep originals).
 *
 * Cancellation: message handlers interleave at await points, so a 'cancel'
 * can land while a convert is in flight. The id is flagged and checked at
 * each stage boundary; an aborted task replies with `cancelled: true` (the
 * main thread has usually already dropped it, which is fine and intended).
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
export type WorkerRequest = ConvertRequest | SampleRequest | CancelRequest;

const cancelled = new Set<number>();
const isCancelled = (id: number) => cancelled.has(id);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  try {
    if (isCancelled(msg.id)) throw new Cancelled();
    const imageBytes = new Uint8Array(msg.imageBytes);
    const decoded = await decodeImage(imageBytes);
    if (isCancelled(msg.id)) throw new Cancelled();
    const profiles = {
      source: { bytes: new Uint8Array(msg.sourceIcc), description: 'source' },
      target: { bytes: new Uint8Array(msg.targetIcc), description: 'target' },
    };
    if (msg.type === 'convert') {
      const result = await convert(decoded, profiles, msg.params);
      if (isCancelled(msg.id)) throw new Cancelled();
      // Copy underlying buffers into fresh transferable snapshots.
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
    if (err instanceof Cancelled) {
      self.postMessage({
        type: msg.type === 'sample' ? 'sample-result' : 'result',
        id: msg.id,
        cancelled: true,
      });
    } else {
      self.postMessage({
        type: msg.type === 'sample' ? 'sample-result' : 'result',
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    cancelled.delete(msg.id);
  }
};

class Cancelled extends Error {}

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
