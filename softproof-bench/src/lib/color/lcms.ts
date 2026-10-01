/**
 * Thin, promise-safe wrapper around the lcms-wasm build of LittleCMS 2.
 *
 * Notes:
 *  - The published `cmsDoTransform` JS wrapper is buggy for floating point
 *    formats: it stages data as Float32 while LittleCMS TYPE_*_DBL expects
 *    Float64, producing garbage. 8/16-bit paths are fine. We therefore run
 *    floating-point (Lab/XYZ/single-pixel) transforms directly against the
 *    Emscripten heap with Float64Array.
 *  - Formatter descriptors come from cmsFormatterForColorspaceOfProfile so
 *    RGB/GRAY/CMYK/Lab/XYZ profiles all work; EXTRA(alpha) is OR-ed in.
 */
import { instantiate } from 'lcms-wasm';
import wasmUrl from 'lcms-wasm/dist/lcms.wasm?url';
import {
  INTENT_PERCEPTUAL,
  INTENT_RELATIVE_COLORIMETRIC,
  INTENT_SATURATION,
  INTENT_ABSOLUTE_COLORIMETRIC,
  cmsFLAGS_COPY_ALPHA,
  cmsFLAGS_BLACKPOINTCOMPENSATION,
  cmsFLAGS_SOFTPROOFING,
  cmsFLAGS_NOCACHE,
} from 'lcms-wasm';
import type { ColorSpaceKind } from '../icc/profileInfo';

export type RenderingIntent =
  | 'perceptual'
  | 'relative-colorimetric'
  | 'saturation'
  | 'absolute-colorimetric';

export const INTENT_VALUE: Record<RenderingIntent, number> = {
  perceptual: INTENT_PERCEPTUAL,
  'relative-colorimetric': INTENT_RELATIVE_COLORIMETRIC,
  saturation: INTENT_SATURATION,
  'absolute-colorimetric': INTENT_ABSOLUTE_COLORIMETRIC,
};

export const INTENT_LABEL: Record<RenderingIntent, string> = {
  perceptual: '感知式 (Perceptual, 0)',
  'relative-colorimetric': '相对色度 (Relative Colorimetric, 1)',
  saturation: '饱和度 (Saturation, 2)',
  'absolute-colorimetric': '绝对色度 (Absolute Colorimetric, 3)',
};

const EXTRA_SH = (e: number) => e << 7;
const ALPHA_EXTRA = EXTRA_SH(1);

type LcmsModule = Awaited<ReturnType<typeof instantiate>>;

let modulePromise: Promise<LcmsModule> | null = null;

export function loadLcms(): Promise<LcmsModule> {
  if (!modulePromise) {
    modulePromise = instantiate({
      locateFile: (name: string) => {
        if (name.endsWith('.wasm')) return wasmUrl;
        return name;
      },
    });
  }
  return modulePromise!;
}

export interface OpenedProfile {
  handle: number;
  bytes: Uint8Array;
  channels: number;
  colorSpace: ColorSpaceKind;
  description: string;
}

/** Open profile bytes with LittleCMS; throws on failure. */
export function openProfile(
  mod: LcmsModule,
  bytes: Uint8Array,
  fallbackName: string,
): { handle: number; description: string; colorSpace: ColorSpaceKind; channels: number } {
  const copy = bytes.slice();
  const handle = mod.cmsOpenProfileFromMem(copy, copy.byteLength);
  if (!handle) throw new Error(`LittleCMS 无法打开配置文件：${fallbackName}`);
  const description = mod.cmsGetProfileInfoASCII(handle, 0 /* cmsInfoDescription */, 'en', 'US') || fallbackName;
  const colorSpace = (mod.cmsGetColorSpaceASCII(handle) as ColorSpaceKind | null) ?? 'other';
  const channelsMap: Record<string, number> = { GRAY: 1, RGB: 3, CMYK: 4, Lab: 3, XYZ: 3, Yxy: 3 };
  const channels = channelsMap[colorSpace] ?? 0;
  return { handle, description, colorSpace, channels };
}

export interface TransformParams {
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  /** When set, build cmsCreateProofingTransform with this profile as the proof device. */
  proofHandle?: number;
  /** Intent used proof->display; relative colorimetric is the press-simulation norm. */
  proofIntent?: RenderingIntent;
  softProof?: boolean;
}

function flagsFor(p: TransformParams): number {
  let f = cmsFLAGS_COPY_ALPHA | cmsFLAGS_NOCACHE;
  if (p.blackPointCompensation) f |= cmsFLAGS_BLACKPOINTCOMPENSATION;
  if (p.softProof) f |= cmsFLAGS_SOFTPROOFING;
  return f;
}

function formatter(mod: LcmsModule, handle: number, bytesPerSample: number, withAlpha: boolean) {
  let fmt = mod.cmsFormatterForColorspaceOfProfile(handle, bytesPerSample, bytesPerSample === 0 ? 1 : 0);
  if (withAlpha) fmt = (fmt | ALPHA_EXTRA) >>> 0;
  return fmt >>> 0;
}

/**
 * Interleaved 8-bit or 16-bit transform with trailing alpha channel on both
 * sides (RGBA / GRAYA / CMYKA). Alpha is copied untouched.
 */
export function transformPixels(opts: {
  mod: LcmsModule;
  srcHandle: number;
  dstHandle: number;
  srcAlpha: boolean;
  dstAlpha: boolean;
  srcBytesPerSample: 1 | 2;
  pixels: Uint8Array | Uint16Array;
  pixelCount: number;
  params: TransformParams;
}): Uint8Array | Uint16Array {
  const { mod } = opts;
  const inFmt = formatter(mod, opts.srcHandle, opts.srcBytesPerSample, opts.srcAlpha);
  const outFmt = formatter(mod, opts.dstHandle, opts.srcBytesPerSample, opts.dstAlpha);
  const flags = flagsFor(opts.params);
  const intent = INTENT_VALUE[opts.params.intent];
  let xform: number;
  if (opts.params.proofHandle) {
    xform = mod.cmsCreateProofingTransform(
      opts.srcHandle,
      inFmt,
      opts.dstHandle,
      outFmt,
      opts.params.proofHandle,
      intent,
      INTENT_VALUE[opts.params.proofIntent ?? 'relative-colorimetric'],
      flags,
    );
  } else {
    xform = mod.cmsCreateTransform(opts.srcHandle, inFmt, opts.dstHandle, outFmt, intent, flags);
  }
  if (!xform) throw new Error('LittleCMS 无法创建转换（配置组合或意图不受支持）');
  try {
    return mod.cmsDoTransform(xform, opts.pixels as unknown as Uint8Array, opts.pixelCount) as
      | Uint8Array
      | Uint16Array;
  } finally {
    mod.cmsDeleteTransform(xform);
  }
}

/**
 * Float64 transform for a single color tuple (no alpha) used by the sampler
 * for exact Lab/XYZ/device values. Input values are normalized 0..1 for
 * RGB/GRAY/CMYK; output is the destination native floating encoding:
 * Lab (L 0..100, a/b), XYZ 0..1+ , CMYK 0..100 (LittleCMS double convention).
 */
export function transformDouble(opts: {
  mod: LcmsModule;
  srcHandle: number;
  dstHandle: number;
  srcChannels: number;
  dstChannels: number;
  values: number[];
  params: TransformParams;
}): number[] {
  const { mod } = opts;
  const inFmt = mod.cmsFormatterForColorspaceOfProfile(opts.srcHandle, 0, 1);
  const outFmt = mod.cmsFormatterForColorspaceOfProfile(opts.dstHandle, 0, 1);
  const flags = (opts.params.blackPointCompensation ? cmsFLAGS_BLACKPOINTCOMPENSATION : 0) | cmsFLAGS_NOCACHE;
  let xform: number;
  if (opts.params.proofHandle) {
    xform = mod.cmsCreateProofingTransform(
      opts.srcHandle,
      inFmt,
      opts.dstHandle,
      outFmt,
      opts.params.proofHandle,
      INTENT_VALUE[opts.params.intent],
      INTENT_VALUE[opts.params.proofIntent ?? 'relative-colorimetric'],
      flags,
    );
  } else {
    xform = mod.cmsCreateTransform(
      opts.srcHandle,
      inFmt,
      opts.dstHandle,
      outFmt,
      INTENT_VALUE[opts.params.intent],
      flags,
    );
  }
  if (!xform) throw new Error('无法创建浮点转换');
  const pIn = mod._malloc(opts.srcChannels * 8);
  const pOut = mod._malloc(opts.dstChannels * 8);
  try {
    new Float64Array(mod.HEAPU8.buffer, pIn, opts.srcChannels).set(opts.values);
    mod._cmsDoTransform(xform, pIn, pOut, 1);
    return [...new Float64Array(mod.HEAPU8.buffer, pOut, opts.dstChannels)];
  } finally {
    mod._free(pIn);
    mod._free(pOut);
    mod.cmsDeleteTransform(xform);
  }
}
