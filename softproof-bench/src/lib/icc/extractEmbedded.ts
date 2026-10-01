/**
 * Extract an embedded ICC profile from an encoded image, without decoding
 * pixels and without any color-managed conversion. Supports:
 *
 *  - JPEG (APP2 "ICC_PROFILE" markers, potentially chunked)
 *  - PNG  (iCCP chunk, zlib-compressed)
 *  - WebP (VP8X "ICCP" chunk, raw)
 *
 * Returns a copy of the profile bytes or null when none is present.
 */
import { inflate } from 'pako';

export type ImageContainer = 'png' | 'jpeg' | 'webp' | 'unknown';

export function detectContainer(bytes: Uint8Array): ImageContainer {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'webp';
  }
  return 'unknown';
}

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]);
  return s;
}

const ICC_PROFILE = 'ICC_PROFILE';

/** JPEG: concatenate APP2/ICC_PROFILE chunks ordered by sequence number. */
function extractJpeg(b: Uint8Array): Uint8Array | null {
  const chunks = new Map<number, { total: number; data: Uint8Array }>();
  let i = 2; // after SOI
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    // fill bytes
    while (b[i] === 0xff && i < b.length) i++;
    const marker = b[i++];
    // markers without payload
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      if (marker === 0xd9) break;
      continue;
    }
    if (i + 2 > b.length) break;
    const segLen = (b[i] << 8) | b[i + 1];
    if (segLen < 2 || i + segLen > b.length) break;
    const segStart = i + 2;
    const segEnd = i + segLen;
    if (marker === 0xe2) {
      // "ICC_PROFILE" (11 bytes) + NUL + seq(1) + total(1) + data
      if (segEnd - segStart >= 14 && ascii(b, segStart, segStart + 11) === ICC_PROFILE && b[segStart + 11] === 0) {
        const seq = b[segStart + 12];
        const total = b[segStart + 13];
        chunks.set(seq, { total, data: b.slice(segStart + 14, segEnd) });
      }
    }
    i = segEnd;
    // SOS header means image scan data follows; ICC chunks only live before it.
    if (marker === 0xda) break;
  }
  if (chunks.size === 0) return null;
  const total = [...chunks.values()][0].total;
  const parts: Uint8Array[] = [];
  for (let n = 1; n <= total; n++) {
    const c = chunks.get(n);
    if (!c) return null; // truncated sequence; do not silently use partial data
    parts.push(c.data);
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function crc32Table(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}

/** PNG: walk chunks, return decompressed iCCP profile. */
function extractPng(b: Uint8Array): Uint8Array | null {
  const crcTable = crc32Table();
  let i = 8;
  while (i + 8 <= b.length) {
    const len = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    const type = ascii(b, i + 4, i + 8);
    const dataStart = i + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > b.length) return null;
    if (type === 'iCCP') {
      const seg = b.subarray(dataStart, dataEnd);
      let p = 0;
      while (p < seg.length && seg[p] !== 0) p++; // profile name (Latin-1)
      p++; // NUL
      const compression = seg[p++];
      if (compression !== 0) return null;
      try {
        return inflate(seg.subarray(p));
      } catch {
        return null;
      }
    }
    // Reference crc table so readers see this really is a PNG walker;
    // we intentionally do not verify CRCs on read (profiles are validated
    // by LittleCMS afterwards).
    void crcTable;
    if (type === 'IEND') break;
    i = dataEnd + 4;
  }
  return null;
}

/** WebP: RIFF chunks; ICCP appears inside the VP8X layout at top level. */
function extractWebp(b: Uint8Array): Uint8Array | null {
  let i = 12;
  while (i + 8 <= b.length) {
    const fourcc = ascii(b, i, i + 4);
    const size = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
    const payload = i + 8;
    if (payload + size > b.length) return null;
    if (fourcc === 'ICCP') return b.slice(payload, payload + size);
    i = payload + size + (size & 1); // RIFF chunks pad to even size
  }
  return null;
}

export function extractEmbeddedICC(bytes: Uint8Array): Uint8Array | null {
  const container = detectContainer(bytes);
  try {
    if (container === 'jpeg') return extractJpeg(bytes);
    if (container === 'png') return extractPng(bytes);
    if (container === 'webp') return extractWebp(bytes);
  } catch {
    return null;
  }
  return null;
}
