/**
 * Minimal little-endian, uncompressed TIFF writer for 8-bit CMYK(A) export.
 *
 * Browsers cannot encode CMYK, so a dedicated writer is required. The output
 * is a standard baseline TIFF readable by ImageMagick/littleCMS, Krita,
 * Ghostscript tooling etc. It embeds:
 *  - ICC profile (tag 34675)
 *  - ImageDescription (tag 270) carrying the conversion provenance
 *
 * CMYK photometric: value 5 (Separate), InkSet=1, NumberOfInks=4,
 * DotRange 0/100. Samples are stored in the usual "ink" convention
 * (0 = no ink, 255 = full ink), matching what LittleCMS TYPE_CMYK_8 emits.
 */

const T_SHORT = 3;
const T_LONG = 4;
const T_RATIONAL = 5;
const T_ASCII = 2;
const T_UNDEFINED = 7;

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** <= 4 byte inline value, or */
  inline?: Uint8Array;
  /** index into the external payload array */
  external?: number;
}

export interface EncodeTiffCmykOptions {
  width: number;
  height: number;
  /** Interleaved CMYK or CMYKA, 8 bits per sample, ink convention 0..255. */
  data: Uint8Array;
  channels: 4 | 5;
  icc?: Uint8Array;
  description?: string;
}

export function encodeTiffCmyk(o: EncodeTiffCmykOptions): Uint8Array {
  const { width, height, channels } = o;
  const rowsPerStrip = height;
  const stripSize = width * height * channels;

  // Payloads that do not fit in the 4-byte value field.
  const externals: Uint8Array[] = [];
  const addExternal = (b: Uint8Array): number => {
    externals.push(b);
    return externals.length - 1;
  };
  const bitsPerSample = addExternal(shorts(new Array(channels).fill(8)));
  const xres = addExternal(rational(72, 1));
  const yres = addExternal(rational(72, 1));
  const dotRange = addExternal(shorts([0, 100]));
  const iccBlock = o.icc ? addExternal(o.icc.slice()) : -1;
  let descBlock = -1;
  if (o.description) {
    descBlock = addExternal(concat([new TextEncoder().encode(o.description), new Uint8Array(1)]));
  }

  const entries: IfdEntry[] = [
    { tag: 256, type: T_LONG, count: 1, inline: u32(width) }, // ImageWidth
    { tag: 257, type: T_LONG, count: 1, inline: u32(height) }, // ImageLength
    { tag: 258, type: T_SHORT, count: channels, external: bitsPerSample }, // BitsPerSample
    { tag: 259, type: T_SHORT, count: 1, inline: shorts([1]) }, // Compression=none
    { tag: 262, type: T_SHORT, count: 1, inline: shorts([5]) }, // Photometric=Separate
    { tag: 273, type: T_LONG, count: 1, inline: u32(0) }, // StripOffsets (patched below)
    { tag: 277, type: T_SHORT, count: 1, inline: shorts([channels]) }, // SamplesPerPixel
    { tag: 278, type: T_LONG, count: 1, inline: u32(rowsPerStrip) },
    { tag: 279, type: T_LONG, count: 1, inline: u32(stripSize) },
    { tag: 282, type: T_RATIONAL, count: 1, external: xres },
    { tag: 283, type: T_RATIONAL, count: 1, external: yres },
    { tag: 284, type: T_SHORT, count: 1, inline: shorts([1]) }, // PlanarConfig=chunky
    { tag: 332, type: T_SHORT, count: 1, inline: shorts([1]) }, // InkSet=CMYK
    { tag: 334, type: T_SHORT, count: 1, inline: shorts([4]) }, // NumberOfInks
    { tag: 336, type: T_SHORT, count: 2, external: dotRange }, // DotRange
  ];
  if (iccBlock >= 0) entries.push({ tag: 34675, type: T_UNDEFINED, count: o.icc!.length, external: iccBlock });
  if (descBlock >= 0)
    entries.push({ tag: 270, type: T_ASCII, count: externals[descBlock].length, external: descBlock });
  entries.sort((a, b) => a.tag - b.tag);

  // File layout: 8-byte header, IFD, external payloads, pixel strip.
  const ifdStart = 8;
  const ifdBytes = 2 + entries.length * 12 + 4;
  let cursor = align2(ifdStart + ifdBytes);
  const extOffsets = externals.map((b) => {
    cursor = align2(cursor);
    const off = cursor;
    cursor = off + b.length;
    return off;
  });
  const stripOff = align2(cursor);
  const total = stripOff + stripSize;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out[0] = 0x49;
  out[1] = 0x49; // "II"
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdStart, true);

  dv.setUint16(ifdStart, entries.length, true);
  let ePos = ifdStart + 2;
  for (const e of entries) {
    dv.setUint16(ePos, e.tag, true);
    dv.setUint16(ePos + 2, e.type, true);
    dv.setUint32(ePos + 4, e.count, true);
    const valuePos = ePos + 8;
    if (e.tag === 273) {
      dv.setUint32(valuePos, stripOff, true);
    } else if (e.external !== undefined) {
      dv.setUint32(valuePos, extOffsets[e.external], true);
    } else if (e.inline) {
      out.set(e.inline, valuePos); // left aligned in the 4-byte slot
    }
    ePos += 12;
  }
  dv.setUint32(ePos, 0, true); // no next IFD

  externals.forEach((b, i) => out.set(b, extOffsets[i]));
  out.set(o.data, stripOff);
  return out;
}

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
}
function shorts(v: number[]): Uint8Array {
  const b = new Uint8Array(v.length * 2);
  const dv = new DataView(b.buffer);
  v.forEach((x, i) => dv.setUint16(i * 2, x, true));
  return b;
}
function rational(num: number, den: number): Uint8Array {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, num, true);
  dv.setUint32(4, den, true);
  return b;
}
function align2(v: number): number {
  return v & 1 ? v + 1 : v;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const o = new Uint8Array(n);
  let p = 0;
  for (const part of parts) o.set(part, p), (p += part.length);
  return o;
}
