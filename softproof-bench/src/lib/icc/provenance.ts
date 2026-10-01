/**
 * Detect the soft-proof provenance marker produced by this tool, so an
 * exported conversion can never be silently treated as an unconverted master.
 */
import { inflate } from 'pako';
import { detectContainer } from '../icc/extractEmbedded';
import { PROVENANCE_KEY } from '../color/record';

export interface Provenance {
  converted: boolean;
  /** Raw marker payload when found. */
  detail?: string;
}

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** Scan PNG tEXt/zTXt chunks for the provenance key. */
function scanPng(b: Uint8Array): Provenance {
  let i = 8;
  while (i + 8 <= b.length) {
    const len = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    const type = ascii(b, i + 4, i + 8);
    const start = i + 8;
    const end = start + len;
    if (end + 4 > b.length) break;
    if (type === 'tEXt') {
      let p = start;
      while (p < end && b[p] !== 0) p++;
      const key = ascii(b, start, p);
      if (key === PROVENANCE_KEY) {
        return { converted: true, detail: new TextDecoder().decode(b.subarray(p + 1, end)) };
      }
    } else if (type === 'zTXt') {
      let p = start;
      while (p < end && b[p] !== 0) p++;
      const key = ascii(b, start, p);
      if (key === PROVENANCE_KEY) {
        try {
          return { converted: true, detail: new TextDecoder().decode(inflate(b.subarray(p + 2, end))) };
        } catch {
          return { converted: true };
        }
      }
    }
    if (type === 'IEND') break;
    i = end + 4;
  }
  return { converted: false };
}

/** Scan a TIFF ImageDescription (tag 270, ASCII) for the marker. */
function scanTiff(b: Uint8Array): Provenance {
  if (b.length < 8 || !(b[0] === 0x49 && b[1] === 0x49)) return { converted: false };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ifd = dv.getUint32(4, true);
  if (ifd + 2 > b.length) return { converted: false };
  const count = dv.getUint16(ifd, true);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > b.length) break;
    const tag = dv.getUint16(e, true);
    if (tag !== 270) continue;
    const type = dv.getUint16(e + 2, true);
    const n = dv.getUint32(e + 4, true);
    if (type !== 2) continue;
    const off = n <= 4 ? e + 8 : dv.getUint32(e + 8, true);
    const text = new TextDecoder().decode(b.subarray(off, off + n));
    if (text.includes(PROVENANCE_KEY)) return { converted: true, detail: text };
  }
  return { converted: false };
}

export function detectProvenance(bytes: Uint8Array): Provenance {
  try {
    const c = detectContainer(bytes);
    if (c === 'png') return scanPng(bytes);
    if (c === 'unknown' && bytes.length > 8 && bytes[0] === 0x49 && bytes[1] === 0x49) return scanTiff(bytes);
  } catch {
    /* ignore */
  }
  return { converted: false };
}
