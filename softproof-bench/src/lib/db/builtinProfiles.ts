/**
 * First-run seeding of openly licensed profiles shipped under /profiles.
 * Users can add their own press profiles at any time; nothing is downloaded.
 */
import srgbUrl from '/profiles/sRGB-elle-V2-srgbtrc.icc?url';
import cieUrl from '/profiles/CIERGB-elle-V2-g22.icc?url';
import { idbAll, idbPut, STORE_PROFILES, type StoredProfile } from '../db/db';
import { readProfileInfo } from '../icc/profileInfo';

export const BUILTIN_PROFILES: { id: string; url: string; label: string }[] = [
  {
    id: 'builtin-srgb-elle',
    url: srgbUrl,
    label: 'sRGB (Elle Stone, V2 sRGB TRC)',
  },
  {
    id: 'builtin-ciergb-elle',
    url: cieUrl,
    label: 'CIE RGB (Elle Stone, V2 gamma 2.2) — 广色域开放配置',
  },
];

export async function seedBuiltinProfiles(): Promise<StoredProfile[]> {
  const existing = new Map((await idbAll<StoredProfile>(STORE_PROFILES)).map((p) => [p.id, p]));
  const seeded: StoredProfile[] = [];
  for (const meta of BUILTIN_PROFILES) {
    if (existing.has(meta.id)) {
      seeded.push(existing.get(meta.id)!);
      continue;
    }
    const resp = await fetch(meta.url);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const info = readProfileInfo(bytes);
    const profile: StoredProfile = {
      id: meta.id,
      bytes,
      description: info.description || meta.label,
      colorSpace: info.colorSpace,
      channels: info.channels,
      origin: 'builtin-open',
      addedAt: new Date().toISOString(),
      size: bytes.byteLength,
    };
    await idbPut(STORE_PROFILES, profile);
    seeded.push(profile);
  }
  return seeded;
}

/** License/attribution note shown in the UI (Elle Stone profiles are public domain). */
export const PROFILE_ATTRIBUTION =
  '内置配置来自 Elle Stone 的开放 ICC 配置库（elles_icc_profiles，公有领域/CC0 贡献）。' +
  '印厂配置（如 ISOcoated/FOGRA、GRACoL、JapanColor）请由用户自行导入，不会从网络下载。';
