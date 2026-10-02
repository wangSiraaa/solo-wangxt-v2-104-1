/**
 * Settings record ("设置记录") that accompanies every export, plus the
 * provenance markers embedded into image files. The record makes clear which
 * profile fed the source side and which was applied, so a converted export is
 * never fed back in as an original.
 */
import type { RenderingIntent } from './lcms';
import type { ColorSpaceKind } from '../icc/profileInfo';

export const PROVENANCE_KEY = 'softproof-bench-conversion';
export const RECORD_FORMAT = 'softproof-bench-settings/1';
export const APP_VERSION = '0.1.0';

export interface ProfileRef {
  /** Stable id inside this browser's IndexedDB, or "builtin:<name>". */
  id: string;
  description: string;
  colorSpace: ColorSpaceKind;
  /** How the source profile was determined. */
  origin: 'embedded' | 'assumed' | 'builtin' | 'user-library';
  /** md5 profile id from the ICC header when present. */
  profileId?: string;
  byteLength: number;
}

export interface SourceAssumption {
  /** true only when the image carried no embedded profile. */
  missingEmbedded: boolean;
  /** The profile the operator chose as the assumed source. */
  assumedProfile?: ProfileRef;
  note?: string;
}

export interface SettingsRecord {
  recordFormat: typeof RECORD_FORMAT;
  createdAt: string;
  application: { name: 'softproof-bench'; version: string };
  image: {
    name: string;
    width: number;
    height: number;
    bitDepth: 8 | 16;
    container: string;
    pixelHash?: string;
  };
  source: ProfileRef;
  sourceAssumption: SourceAssumption;
  target: ProfileRef;
  transform: {
    intent: RenderingIntent;
    intentCode: number;
    blackPointCompensation: boolean;
    proofIntent?: RenderingIntent;
    proofIntentCode?: number;
  };
  export: {
    kind: 'rgb-png' | 'gray-png' | 'cmyk-tiff';
    bitDepth: 8 | 16;
    embedsTargetICC: boolean;
    fileName: string;
  };
  disclaimer: string;
}

export const DISCLAIMER =
  '本结果由浏览器内 LittleCMS(WASM) 计算，仅用于软打样预览与流程核对；' +
  '在未经校准/特征化的显示器上，不承诺与实物打样或印刷成品颜色一致。';

export function provenanceText(r: Pick<SettingsRecord, 'source' | 'target' | 'transform' | 'createdAt'>): string {
  const parts = [
    'v=1',
    `created=${r.createdAt}`,
    `source=${r.source.id}:${r.source.description}`.slice(0, 600),
    `sourceOrigin=${r.source.origin}`,
    `target=${r.target.id}:${r.target.description}`.slice(0, 600),
    `intent=${r.transform.intent}`,
    `bpc=${r.transform.blackPointCompensation ? 1 : 0}`,
    'this-file-is-converted-not-original=1',
  ];
  return parts.join('; ');
}
