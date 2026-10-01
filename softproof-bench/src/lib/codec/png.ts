/**
 * Dependency-light PNG writer used for exports, because canvas-based encoders
 * cannot embed ICC profiles and silently run browser color management.
 *
 * Supports truecolor RGB/RGBA and grayscale GRAY/GRAYA at 8 or 16 bits per
 * sample. Writes:
 *  - iCCP : target/profile ICC (zlib compressed)
 *  - tEXt : provenance (softproof-bench-conversion: ...) so a re-imported
 *           result is never mistaken for an unconverted original.
 */
import { deflate } from 'pako';

let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  out.set(typeBytes, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(concat([typeBytes, data])), false);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface EncodePngOptions {
  width: number;
  height: number;
  /** 1 (gray) or 3 (RGB); alpha toggles the alpha channel. */
  colorChannels: 1 | 3;
  bitDepth: 8 | 16;
  /** Interleaved samples WITHOUT alpha: GRAY/GRAYA/RGB/RGBA in row order. */
  data: Uint8Array; // byte view; 16-bit data is read via Uint16Array(data.buffer...)
  hasAlpha: boolean;
  icc?: Uint8Array;
  /** Raw ICC profile name for the iCCP keyword (ASCII, <= 79). */
  iccName?: string;
  /** tEXt key/value pairs. */
  text?: Record<string, string>;
}

export function encodePng(o: EncodePngOptions): Uint8Array {
  const { width, height, bitDepth, hasAlpha } = o;
  const colorType = o.colorChannels === 1 ? (hasAlpha ? 4 : 0) : hasAlpha ? 6 : 2;
  const bytesPerSample = bitDepth / 8;
  const channels = o.colorChannels + (hasAlpha ? 1 : 0);
  const rowBytes = width * channels * bytesPerSample;
  const stride = rowBytes + 1;

  // Re-pack big-endian for 16-bit; 8-bit is copied as-is; add filter byte 0.
  const raw = new Uint8Array(height * stride);
  if (bitDepth === 8) {
    for (let y = 0; y < height; y++) {
      raw[y * stride] = 0;
      raw.set(o.data.subarray(y * rowBytes, (y + 1) * rowBytes), y * stride + 1);
    }
  } else {
    const src16 = new Uint16Array(o.data.buffer, o.data.byteOffset, (height * rowBytes) / 2);
    const dv = new DataView(raw.buffer);
    let p = 0;
    for (let y = 0; y < height; y++) {
      raw[p++] = 0;
      for (let x = 0; x < width * channels; x++) dv.setUint16(p, src16[y * width * channels + x], false), (p += 2);
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrDv = new DataView(ihdr.buffer);
  ihdrDv.setUint32(0, width, false);
  ihdrDv.setUint32(4, height, false);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // non-interlaced

  const parts: Uint8Array[] = [SIGNATURE, chunk('IHDR', ihdr)];

  // iCCP: name\0 compressionMethod(0) deflate(icc)
  if (o.icc) {
    const name = (o.iccName || 'ICC profile').replace(/[^\x20-\x7e]/g, '_').slice(0, 79);
    const nameBytes = new TextEncoder().encode(name);
    const comp = deflate(o.icc);
    const body = new Uint8Array(nameBytes.length + 2 + comp.length);
    body.set(nameBytes, 0);
    body[nameBytes.length] = 0;
    body[nameBytes.length + 1] = 0;
    body.set(comp, nameBytes.length + 2);
    parts.push(chunk('iCCP', body));
  }

  if (o.text) {
    for (const [k, v] of Object.entries(o.text)) {
      const kb = new TextEncoder().encode(k.slice(0, 79));
      const vb = new TextEncoder().encode(v).slice(0, 79000 - kb.length - 1);
      const body = new Uint8Array(kb.length + 1 + vb.length);
      body.set(kb, 0);
      body[kb.length] = 0;
      body.set(vb, kb.length + 1);
      parts.push(chunk('tEXt', body));
    }
  }

  const idat = deflate(raw, { level: 6 });
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return concat(parts);
}
