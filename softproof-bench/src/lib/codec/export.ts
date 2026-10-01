/**
 * Export assembly. Two separate artifacts, each self-describing:
 *
 *  1. converted image - pixel data is already in target profile encoding;
 *     the target ICC is embedded (PNG iCCP / TIFF 34675) and a provenance
 *     text marker states "this file is converted, not an original".
 *  2. settings record - JSON with source/target profile identity, intent,
 *     BPC, assumption for missing embedded profiles, hash and disclaimer.
 */
import { encodePng } from './png';
import { encodeTiffCmyk } from './tiff';
import { PROVENANCE_KEY, type SettingsRecord } from '../color/record';
import type { ConvertedPayload } from '../workers/client';
import type { ProfileRef } from '../color/record';

export interface ExportInput {
  converted: ConvertedPayload;
  targetIcc: Uint8Array;
  targetIccName: string;
  baseName: string;
  record: SettingsRecord;
}

export interface ExportedFiles {
  image: { name: string; bytes: Uint8Array; mime: string };
  json: { name: string; bytes: Uint8Array };
}

export async function buildExport(o: ExportInput): Promise<ExportedFiles> {
  const provenance = JSON.stringify({
    key: PROVENANCE_KEY,
    recordFormat: o.record.recordFormat,
    createdAt: o.record.createdAt,
    source: `${o.record.source.description} [${o.record.source.origin}]`,
    target: o.record.target.description,
    intent: o.record.transform.intent,
    bpc: o.record.transform.blackPointCompensation,
    convertedNotOriginal: true,
  });

  let image: ExportedFiles['image'];
  if (o.converted.targetColorSpace === 'CMYK') {
    // 8-bit CMYK TIFF carries no alpha channel. Transparent source pixels have
    // meaningless ink values (their color was still transformed); zero the
    // inks where alpha=0 so the press file does not lay ink on "transparent"
    // areas (standard no-ink treatment).
    const srcCh = o.converted.convertedChannels; // 4 or 5 when alpha present
    const hasAlpha = o.converted.hasAlpha && srcCh === 5;
    const cmyk = new Uint8Array(o.converted.width * o.converted.height * 4);
    const src = o.converted.converted;
    for (let i = 0; i < o.converted.width * o.converted.height; i++) {
      if (hasAlpha && src[i * srcCh + 4] === 0) continue; // leave 0 inks
      for (let c = 0; c < 4; c++) cmyk[i * 4 + c] = src[i * srcCh + c];
    }
    const bytes = encodeTiffCmyk({
      width: o.converted.width,
      height: o.converted.height,
      data: cmyk,
      channels: 4,
      icc: o.targetIcc,
      description: provenance,
    });
    image = { name: `${o.baseName}.proof-${sanitize(o.record.target.id)}.tif`, bytes, mime: 'image/tiff' };
    o.record.export = { kind: 'cmyk-tiff', bitDepth: 8, embedsTargetICC: true, fileName: image.name };
  } else {
    const colorChannels: 1 | 3 = o.converted.targetColorSpace === 'GRAY' ? 1 : 3;
    const bytes = encodePng({
      width: o.converted.width,
      height: o.converted.height,
      colorChannels,
      bitDepth: o.converted.bitDepth,
      // converted is already packed color channels + trailing alpha
      data: o.converted.converted,
      hasAlpha: o.converted.hasAlpha,
      icc: o.targetIcc,
      iccName: o.targetIccName,
      text: {
        [PROVENANCE_KEY]: provenance,
        'Source-Profile': `${o.record.source.description} (${o.record.source.origin})`.slice(0, 7900),
        'Target-Profile': o.record.target.description.slice(0, 7900),
        Comment: 'Converted by softproof-bench; not an original camera/master image.',
      },
    });
    image = {
      name: `${o.baseName}.proof-${sanitize(o.record.target.id)}.png`,
      bytes,
      mime: 'image/png',
    };
    o.record.export = {
      kind: colorChannels === 1 ? 'gray-png' : 'rgb-png',
      bitDepth: o.converted.bitDepth,
      embedsTargetICC: true,
      fileName: image.name,
    };
  }

  const json = new TextEncoder().encode(JSON.stringify(o.record, null, 2));
  return { image, json: { name: `${o.baseName}.proof-settings.json`, bytes: json } };
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'profile';
}

export function downloadBytes(name: string, bytes: Uint8Array, mime: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function profileRefOf(
  id: string,
  description: string,
  colorSpace: SettingsRecord['target']['colorSpace'],
  origin: ProfileRef['origin'],
  byteLength: number,
  profileId?: string,
): ProfileRef {
  return { id, description, colorSpace, origin, byteLength, profileId };
}
