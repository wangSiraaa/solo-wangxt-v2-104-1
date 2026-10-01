declare module 'lcms-wasm' {
  export const LCMS_VERSION: number;

  // Pixel type / formatter constants
  export const PT_ANY = 0;
  export const PT_GRAY = 3;
  export const PT_RGB = 4;
  export const PT_CMY = 5;
  export const PT_CMYK = 6;
  export const PT_XYZ = 9;
  export const PT_Lab = 10;

  export const FLOAT_SH: (a: number) => number;
  export const COLORSPACE_SH: (s: number) => number;
  export const EXTRA_SH: (e: number) => number;
  export const CHANNELS_SH: (c: number) => number;
  export const BYTES_SH: (b: number) => number;
  export const T_FLOAT: (a: number) => number;
  export const T_CHANNELS: (c: number) => number;
  export const T_BYTES: (b: number) => number;
  export const T_EXTRA: (e: number) => number;

  export const TYPE_GRAY_8: number;
  export const TYPE_GRAYA_8: number;
  export const TYPE_RGB_8: number;
  export const TYPE_RGBA_8: number;
  export const TYPE_RGB_16: number;
  export const TYPE_RGBA_16: number;
  export const TYPE_CMYK_8: number;
  export const TYPE_CMYKA_8: number;
  export const TYPE_Lab_DBL: number;
  export const TYPE_XYZ_DBL: number;
  export const TYPE_RGB_DBL: number;
  export const TYPE_GRAY_DBL: number;
  export const TYPE_CMYK_DBL: number;

  export const cmsInfoDescription = 0;
  export const cmsInfoManufacturer = 1;
  export const cmsInfoModel = 2;
  export const cmsInfoCopyright = 3;

  export const INTENT_PERCEPTUAL = 0;
  export const INTENT_RELATIVE_COLORIMETRIC = 1;
  export const INTENT_SATURATION = 2;
  export const INTENT_ABSOLUTE_COLORIMETRIC = 3;

  export const cmsFLAGS_NOCACHE: number;
  export const cmsFLAGS_NOOPTIMIZE: number;
  export const cmsFLAGS_NULLTRANSFORM: number;
  export const cmsFLAGS_GAMUTCHECK: number;
  export const cmsFLAGS_SOFTPROOFING: number;
  export const cmsFLAGS_BLACKPOINTCOMPENSATION: number;
  export const cmsFLAGS_NOWHITEONWHITEFIXUP: number;
  export const cmsFLAGS_HIGHRESPRECALC: number;
  export const cmsFLAGS_LOWRESPRECALC: number;
  export const cmsFLAGS_COPY_ALPHA: number;

  export interface LcmsInstance {
    HEAPU8: Uint8Array;
    _malloc(size: number): number;
    _free(ptr: number): void;
    _cmsDoTransform(transform: number, inputBuffer: number, outputBuffer: number, size: number): void;
    cmsOpenProfileFromMem(data: Uint8Array, size: number): number;
    cmsCloseProfile(handle: number): number;
    cmsCreate_sRGBProfile(): number;
    cmsCreateXYZProfile(): number;
    cmsCreateLab4Profile(whitePoint?: number): number;
    cmsGetProfileInfoASCII(
      hProfile: number,
      info: number,
      languageCode: string,
      countryCode: string,
    ): string;
    cmsGetColorSpace(handle: number): number;
    cmsGetColorSpaceASCII(handle: number): string | null;
    cmsFormatterForColorspaceOfProfile(handle: number, nBytes: number, isFloat: number): number;
    cmsCreateTransform(
      hInput: number,
      inputFormat: number,
      hOutput: number,
      outputFormat: number,
      intent: number,
      flags: number,
    ): number;
    cmsCreateProofingTransform(
      hInput: number,
      inputFormat: number,
      hOutput: number,
      outputFormat: number,
      hProof: number,
      intent: number,
      proofIntent: number,
      flags: number,
    ): number;
    cmsDeleteTransform(transform: number): void;
    cmsGetTransformInputFormat(transform: number): number;
    cmsGetTransformOutputFormat(transform: number): number;
    cmsDoTransform<T extends Uint8Array | Uint16Array>(
      transform: number,
      input: T,
      size: number,
    ): T;
  }

  export interface InstantiateOptions {
    locateFile?: (name: string) => string;
    [key: string]: unknown;
  }

  export function instantiate(options?: InstantiateOptions): Promise<LcmsInstance>;
}
