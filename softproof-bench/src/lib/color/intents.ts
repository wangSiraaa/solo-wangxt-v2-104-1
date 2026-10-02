/**
 * Rendering intent constants/labels in a dependency-free module so settings
 * records and batch manifests can be built (and unit-tered in Node) without
 * pulling in the LittleCMS WASM wrapper.
 */
export type RenderingIntent =
  | 'perceptual'
  | 'relative-colorimetric'
  | 'saturation'
  | 'absolute-colorimetric';

// LCMS cmsUInt32Number intent codes (lcms.h).
export const INTENT_VALUE: Record<RenderingIntent, number> = {
  perceptual: 0,
  'relative-colorimetric': 1,
  saturation: 2,
  'absolute-colorimetric': 3,
};

export const INTENT_LABEL: Record<RenderingIntent, string> = {
  perceptual: '感知式 (Perceptual, 0)',
  'relative-colorimetric': '相对色度 (Relative Colorimetric, 1)',
  saturation: '饱和度 (Saturation, 2)',
  'absolute-colorimetric': '绝对色度 (Absolute Colorimetric, 3)',
};
