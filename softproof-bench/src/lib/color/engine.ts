/**
 * Pure transform engine used inside the Web Worker. Everything operates on
 * already-decoded raw pixels; browsers never re-encode or color-manage data
 * behind our back.
 *
 * Two distinct pixel paths, deliberately not conflated:
 *
 *  1. conversion  : source profile -> TARGET profile device encoding
 *                   (RGB/CMYK/GRAY). This is what gets exported and embedded
 *                   with the target ICC.
 *  2. soft proof  : source profile -> sRGB display profile, with the TARGET
 *                   profile as the proofing device. This simulates how the
 *                   target result would look on a calibrated display; it is
 *                   only a screen preview, never re-used as pixel source.
 *
 * Pixels are always kept PACKED with trailing alpha (RGBA / CMYKA / GRAYA),
 * matching LittleCMS formatters built with the EXTRA(alpha) bit. The sampler
 * builds float64 versions of the chains per clicked pixel so numbers are not
 * quantized by the 8-bit preview.
 */
import { loadLcms, openProfile, transformPixels, transformDouble } from './lcms';
import type { RenderingIntent } from './lcms';
import type { ColorSpaceKind } from '../icc/profileInfo';
import type { DecodedImage } from '../codec/decode';

export interface ProfileSet {
  source: { bytes: Uint8Array; description: string };
  target: { bytes: Uint8Array; description: string };
}

export interface EngineParams {
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  proofIntent: RenderingIntent;
}

export interface ConvertResult {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  targetColorSpace: ColorSpaceKind;
  /** Converted device pixels, packed color channels + trailing alpha if present. */
  converted: Uint8Array;
  convertedColorChannels: 1 | 3 | 4;
  convertedChannels: number;
  /** 8-bit packed RGBA soft-proof preview for canvas display. */
  softProofRGBA: Uint8Array;
  hasAlpha: boolean;
}

type Mod = Awaited<ReturnType<typeof loadLcms>>;

let modPromise: Promise<Mod> | null = null;
function getMod(): Promise<Mod> {
  modPromise ??= loadLcms();
  return modPromise;
}

interface Packed {
  /** Packed samples: color channels followed by alpha when present. */
  view: Uint8Array | Uint16Array;
  colorChannels: 1 | 3;
  hasAlpha: boolean;
  bitDepth: 8 | 16;
}

/** Normalize decoder output to packed [color channels](+alpha) straight alpha. */
function normalize(decoded: DecodedImage): Packed {
  const bitDepth = decoded.bitDepth;
  if (decoded.channels === 4) {
    // Already RGBA / RGBA16 from jsquash.
    const view = bitDepth === 16 ? decoded.data16! : decoded.data;
    return { view, colorChannels: 3, hasAlpha: true, bitDepth };
  }
  if (decoded.channels === 3) {
    return { view: decoded.data, colorChannels: 3, hasAlpha: false, bitDepth };
  }
  return { view: decoded.data, colorChannels: 1, hasAlpha: false, bitDepth };
}

const colorChannelsOf = (cs: ColorSpaceKind): 1 | 3 | 4 =>
  cs === 'GRAY' ? 1 : cs === 'CMYK' ? 4 : 3;

/** Downscale packed 16-bit samples to packed 8-bit RGBA (alpha included). */
function packed16ToRGBA8(p16: Uint16Array, channels: number, pixelCount: number, hasAlpha: boolean): Uint8Array {
  const out = new Uint8Array(pixelCount * 4);
  if (channels === 4 && hasAlpha) {
    for (let i = 0; i < pixelCount; i++) {
      out[i * 4] = p16[i * 4] >> 8;
      out[i * 4 + 1] = p16[i * 4 + 1] >> 8;
      out[i * 4 + 2] = p16[i * 4 + 2] >> 8;
      out[i * 4 + 3] = p16[i * 4 + 3] >> 8;
    }
  } else {
    // RGB/GRAY without alpha (or 3 packed)
    for (let i = 0; i < pixelCount; i++) {
      out[i * 4] = channels === 1 ? p16[i] >> 8 : p16[i * 3] >> 8;
      out[i * 4 + 1] = channels === 1 ? out[i * 4] : p16[i * 3 + 1] >> 8;
      out[i * 4 + 2] = channels === 1 ? out[i * 4] : p16[i * 3 + 2] >> 8;
      out[i * 4 + 3] = hasAlpha && channels === 1 ? p16[i + 1] >> 8 : 255;
    }
  }
  return out;
}

/** Add opaque alpha to packed color-only 8-bit pixels, returning RGBA. */
function packed8ToRGBA(p8: Uint8Array, channels: number, pixelCount: number): Uint8Array {
  if (channels === 4) return p8; // already RGBA
  const out = new Uint8Array(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    out[i * 4] = channels === 1 ? p8[i] : p8[i * 3];
    out[i * 4 + 1] = channels === 1 ? p8[i] : p8[i * 3 + 1];
    out[i * 4 + 2] = channels === 1 ? p8[i] : p8[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

export async function convert(decoded: DecodedImage, profiles: ProfileSet, params: EngineParams): Promise<ConvertResult> {
  const lcms = await getMod();
  const src = openProfile(lcms, profiles.source.bytes, 'source');
  const dst = openProfile(lcms, profiles.target.bytes, 'target');
  const srgb = { handle: lcms.cmsCreate_sRGBProfile() };

  const norm = normalize(decoded);
  const pixelCount = decoded.width * decoded.height;
  const bytesPerSample: 1 | 2 = norm.bitDepth === 16 ? 2 : 1;

  // ---- Stage 1: source -> target device (alpha carried via COPY_ALPHA) ----
  const convertedPacked = transformPixels({
    mod: lcms,
    srcHandle: src.handle,
    dstHandle: dst.handle,
    srcAlpha: norm.hasAlpha,
    dstAlpha: norm.hasAlpha,
    srcBytesPerSample: bytesPerSample,
    pixels: norm.view,
    pixelCount,
    params: { intent: params.intent, blackPointCompensation: params.blackPointCompensation },
  });

  const dstColorChannels = colorChannelsOf(dst.colorSpace);
  const convertedBytes =
    convertedPacked instanceof Uint16Array
      ? new Uint8Array(convertedPacked.buffer, convertedPacked.byteOffset, convertedPacked.byteLength)
      : (convertedPacked as Uint8Array);

  // ---- Stage 2: source -> display sRGB with target as proof device ----
  const proofPacked = transformPixels({
    mod: lcms,
    srcHandle: src.handle,
    dstHandle: srgb.handle,
    srcAlpha: norm.hasAlpha,
    dstAlpha: norm.hasAlpha,
    srcBytesPerSample: bytesPerSample,
    pixels: norm.view,
    pixelCount,
    params: {
      intent: params.intent,
      blackPointCompensation: params.blackPointCompensation,
      proofHandle: dst.handle,
      proofIntent: params.proofIntent,
      softProof: true,
    },
  });

  // Soft proof is always presented 8-bit packed RGBA on canvas.
  const proofRGBA =
    norm.bitDepth === 16
      ? packed16ToRGBA8(proofPacked as Uint16Array, 4, pixelCount, norm.hasAlpha)
      : packed8ToRGBA(proofPacked as Uint8Array, norm.hasAlpha ? 4 : 3, pixelCount);

  lcms.cmsCloseProfile(src.handle);
  lcms.cmsCloseProfile(dst.handle);
  lcms.cmsCloseProfile(srgb.handle);

  return {
    width: decoded.width,
    height: decoded.height,
    bitDepth: norm.bitDepth,
    targetColorSpace: dst.colorSpace,
    converted: convertedBytes,
    convertedColorChannels: dstColorChannels,
    convertedChannels: dstColorChannels + (norm.hasAlpha ? 1 : 0),
    softProofRGBA: proofRGBA,
    hasAlpha: norm.hasAlpha,
  };
}

export interface SampleInfo {
  /** Source device values normalized to 0..1 (RGB/GRAY) or 0..100 (CMYK). */
  sourceDevice: number[];
  sourceLab: [number, number, number];
  targetDevice: number[];
  targetLab: [number, number, number];
  alpha8: number;
  sourceColorSpace: ColorSpaceKind;
  targetColorSpace: ColorSpaceKind;
}

/** Float64 sampling at one pixel, values normalized from file bit depth. */
export async function samplePixel(
  decoded: DecodedImage,
  profiles: ProfileSet,
  params: EngineParams,
  x: number,
  y: number,
): Promise<SampleInfo> {
  const lcms = await getMod();
  const src = openProfile(lcms, profiles.source.bytes, 'source');
  const dst = openProfile(lcms, profiles.target.bytes, 'target');
  const lab = { handle: lcms.cmsCreateLab4Profile() };

  const norm = normalize(decoded);
  const idx = y * decoded.width + x;
  const max = norm.bitDepth === 16 ? 65535 : 255;
  const vals: number[] = [];
  for (let c = 0; c < norm.colorChannels; c++) vals.push(norm.view[idx * (norm.colorChannels + (norm.hasAlpha ? 1 : 0)) + c] / max);
  let alpha8 = 255;
  if (norm.hasAlpha) {
    const a = norm.view[idx * (norm.colorChannels + 1) + norm.colorChannels];
    alpha8 = norm.bitDepth === 16 ? (a as number) >> 8 : (a as number);
  }

  const sourceLab = transformDouble({
    mod: lcms,
    srcHandle: src.handle,
    dstHandle: lab.handle,
    srcChannels: src.channels,
    dstChannels: 3,
    values: vals,
    params: { intent: params.intent, blackPointCompensation: params.blackPointCompensation },
  }) as [number, number, number];

  const targetDevice = transformDouble({
    mod: lcms,
    srcHandle: src.handle,
    dstHandle: dst.handle,
    srcChannels: src.channels,
    dstChannels: dst.channels,
    values: vals,
    params: { intent: params.intent, blackPointCompensation: params.blackPointCompensation },
  });

  // Lab through the actual target profile, so numbers reflect the exported
  // encoding rather than a shortcut straight from the PCS.
  const targetNorm = targetDevice.map((v) => (dst.colorSpace === 'CMYK' ? v / 100 : v));
  const targetLab = transformDouble({
    mod: lcms,
    srcHandle: dst.handle,
    dstHandle: lab.handle,
    srcChannels: dst.channels,
    dstChannels: 3,
    values: targetNorm,
    params: { intent: 'relative-colorimetric', blackPointCompensation: false },
  }) as [number, number, number];

  lcms.cmsCloseProfile(src.handle);
  lcms.cmsCloseProfile(dst.handle);
  lcms.cmsCloseProfile(lab.handle);

  return {
    sourceDevice: vals,
    sourceLab,
    targetDevice,
    targetLab,
    alpha8,
    sourceColorSpace: src.colorSpace,
    targetColorSpace: dst.colorSpace,
  };
}
