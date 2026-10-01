/**
 * Decode image containers to *raw* interleaved pixels with no browser color
 * management applied. Primary path uses @jsquash WASM codecs (values come
 * straight from the file); the fallback path asks createImageBitmap to skip
 * color-space conversion (where supported) and reads pixels via OffscreenCanvas.
 */
import pngDecode from '@jsquash/png/decode';
import jpegDecode from '@jsquash/jpeg/decode';
import webpDecode from '@jsquash/webp/decode';
import { detectContainer } from '../icc/extractEmbedded';

export type PixelChannels = 1 | 3 | 4;

export interface DecodedImage {
  width: number;
  height: number;
  /** Interleaved: RGBA when channels=4, RGB when 3, GRAY when 1. */
  data: Uint8Array;
  channels: PixelChannels;
  bitDepth: 8 | 16;
  /** Uint16 view when the source carries 16-bit samples. */
  data16?: Uint16Array;
  container: 'png' | 'jpeg' | 'webp' | 'unknown';
  /** True if the browser had a hand in decoding (color management may have run). */
  decodedByBrowser: boolean;
}

async function decodeJsquash(bytes: Uint8Array, container: string): Promise<DecodedImage | null> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  try {
    if (container === 'png') {
      const is16 = pngBitDepth16(bytes);
      if (is16) {
        const r = await pngDecode(buf, { bitDepth: 16 });
        const data16 = r.data;
        return {
          width: r.width,
          height: r.height,
          data: new Uint8Array(data16.buffer, data16.byteOffset, data16.byteLength),
          data16,
          channels: 4 as PixelChannels,
          bitDepth: 16,
          container,
          decodedByBrowser: false,
        };
      }
      const r = await pngDecode(buf);
      return {
        width: r.width,
        height: r.height,
        data: new Uint8Array(r.data),
        channels: 4 as PixelChannels,
        bitDepth: 8,
        container,
        decodedByBrowser: false,
      };
    }
    if (container === 'jpeg') {
      const r = await jpegDecode(buf);
      return {
        width: r.width,
        height: r.height,
        data: new Uint8Array(r.data),
        channels: 4 as PixelChannels,
        bitDepth: 8,
        container,
        decodedByBrowser: false,
      };
    }
    if (container === 'webp') {
      const r = await webpDecode(buf);
      return {
        width: r.width,
        height: r.height,
        data: new Uint8Array(r.data),
        channels: 4 as PixelChannels,
        bitDepth: 8,
        container,
        decodedByBrowser: false,
      };
    }
  } catch (err) {
    console.warn('jsquash 解码失败，回退浏览器解码', err);
  }
  return null;
}

/** Read PNG IHDR bit depth / color type without decoding. */
function pngBitDepth16(b: Uint8Array): boolean {
  if (b.length < 24) return false;
  // IHDR is the first chunk: length at 8, type at 12, width.. then bitDepth at 24.
  const type = [b[12], b[13], b[14], b[15]].map((c) => String.fromCharCode(c)).join('');
  return type === 'IHDR' && b[24] === 16;
}

async function decodeBrowser(bytes: Uint8Array): Promise<DecodedImage> {
  const blob = new Blob([bytes.slice()]);
  const bmp = await createImageBitmap(blob, {
    // Request raw decoding; unsupported fields are ignored by older engines.
    colorSpaceConversion: 'none',
  } as ImageBitmapOptions);
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('无法建立 2D 画布');
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return {
      width: bmp.width,
      height: bmp.height,
      data: new Uint8Array(img.data),
      channels: 4 as PixelChannels,
      bitDepth: 8,
      container: detectContainer(bytes),
      decodedByBrowser: true,
    };
  } finally {
    bmp.close();
  }
}

/**
 * Normalize decoded pixels to interleaved RGBA (or RGBA16) ready for LCMS,
 * keeping premultiplied data unmodified. jsquash outputs straight alpha.
 */
export async function decodeImage(bytes: Uint8Array): Promise<DecodedImage> {
  const container = detectContainer(bytes);
  if (container === 'unknown') {
    throw new Error('不支持的图片格式（仅支持 PNG / JPEG / WebP）');
  }
  const js = await decodeJsquash(bytes, container);
  if (js) return js;
  return decodeBrowser(bytes);
}
