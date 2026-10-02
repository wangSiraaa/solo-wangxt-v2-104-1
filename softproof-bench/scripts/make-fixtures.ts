/**
 * Generate browser E2E fixtures:
 *  1. patches-srgb.png      - 8-bit RGBA color blocks with TRANSPARENT borders,
 *                             iCCP = open sRGB profile
 *  2. patches-noicc.png     - same pixel content, no profile (forces source choice)
 *  3. patches-srgb16.png    - 16-bit RGB variant with iCCP
 *  4. patches-ciergb.png    - 8-bit RGBA, iCCP = open CIE RGB profile (a second,
 *                             distinct embedded profile for batch tests)
 *  5. broken-icc.png        - valid signature + IHDR + iCCP, then truncated:
 *                             ICC extraction succeeds but decoding fails
 *                             (drives the batch failure/retry path)
 *
 * Uses the app's own PNG encoder so fixtures exercise the same code path.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodePng } from '../src/lib/codec/png';
import { readFileSync } from 'node:fs';

const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, 'test-assets/browser');
mkdirSync(dir, { recursive: true });
const srgbIcc = new Uint8Array(readFileSync(resolve(root, 'public/profiles/sRGB-elle-V2-srgbtrc.icc')));
const ciergbIcc = new Uint8Array(readFileSync(resolve(root, 'public/profiles/CIERGB-elle-V2-g22.icc')));

const W = 12;
const H = 8;

function makeRGBA(): Uint8Array {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      if (border) {
        data[i] = 255;
        data[i + 1] = 0;
        data[i + 2] = 255;
        data[i + 3] = 0; // transparent edge
        continue;
      }
      // interior color blocks
      const blocks: [number, number, number, number][] = [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255],
        [0, 255, 255, 255],
        [255, 0, 255, 255],
        [128, 128, 128, 255],
        [255, 255, 255, 255],
        [0, 0, 0, 255],
        [64, 160, 220, 255],
      ];
      const bx = Math.floor((x - 1) / 3);
      const by = Math.floor((y - 1) / 2);
      const b = blocks[Math.min(blocks.length - 1, by * 3 + bx)];
      data.set(b, i);
    }
  }
  return data;
}

const rgba = makeRGBA();

writeFileSync(
  resolve(dir, 'patches-srgb.png'),
  encodePng({ width: W, height: H, colorChannels: 3, bitDepth: 8, data: rgba, hasAlpha: true, icc: srgbIcc }),
);
writeFileSync(
  resolve(dir, 'patches-noicc.png'),
  encodePng({ width: W, height: H, colorChannels: 3, bitDepth: 8, data: rgba, hasAlpha: true }),
);

// 16-bit version: scale values, opaque interior
const rgba16 = new Uint16Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  rgba16[i * 4] = rgba[i * 4] * 257;
  rgba16[i * 4 + 1] = rgba[i * 4 + 1] * 257;
  rgba16[i * 4 + 2] = rgba[i * 4 + 2] * 257;
  rgba16[i * 4 + 3] = rgba[i * 4 + 3] * 257;
}
writeFileSync(
  resolve(dir, 'patches-srgb16.png'),
  encodePng({
    width: W,
    height: H,
    colorChannels: 3,
    bitDepth: 16,
    data: new Uint8Array(rgba16.buffer),
    hasAlpha: true,
    icc: srgbIcc,
  }),
);

// Same geometry, channel-rotated pixels, embedded CIE RGB profile: a second
// distinct embedded profile for the batch acceptance tests.
const rgbaB = makeRGBA();
for (let i = 0; i < rgbaB.length; i += 4) {
  const r = rgbaB[i];
  rgbaB[i] = rgbaB[i + 2];
  rgbaB[i + 2] = r;
}
writeFileSync(
  resolve(dir, 'patches-ciergb.png'),
  encodePng({ width: W, height: H, colorChannels: 3, bitDepth: 8, data: rgbaB, hasAlpha: true, icc: ciergbIcc }),
);

// Truncated right after the iCCP chunk: the container is a PNG, the embedded
// profile still extracts, but pixel decoding must fail.
const full = encodePng({ width: W, height: H, colorChannels: 3, bitDepth: 8, data: rgba, hasAlpha: true, icc: srgbIcc });
let cut = 8;
while (cut + 8 <= full.length) {
  const len = (full[cut] << 24) | (full[cut + 1] << 16) | (full[cut + 2] << 8) | full[cut + 3];
  const type = String.fromCharCode(full[cut + 4], full[cut + 5], full[cut + 6], full[cut + 7]);
  const end = cut + 8 + len + 4;
  if (type === 'iCCP') {
    cut = end + 12; // keep all of iCCP plus a dangling partial next chunk
    break;
  }
  cut = end;
}
writeFileSync(resolve(dir, 'broken-icc.png'), full.subarray(0, Math.min(cut, full.length - 1)));

console.log('fixtures written to', dir);
