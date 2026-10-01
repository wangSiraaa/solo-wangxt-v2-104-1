/**
 * Central application state (Svelte 5 runes). Owns:
 *  - imported image bytes + embedded/assumed source profile decision
 *  - profile library (IndexedDB)
 *  - target profile, intent, BPC
 *  - worker conversion results + sampler
 *  - project save/load
 */
import { idbAll, idbDelete, idbPut, STORE_PROJECTS, STORE_PROFILES, type StoredProfile, type StoredProject } from './db';
import { seedBuiltinProfiles } from './builtinProfiles';
import { extractEmbeddedICC, detectContainer } from '../icc/extractEmbedded';
import { readProfileInfo, type ProfileInfo, type ColorSpaceKind } from '../icc/profileInfo';
import { detectProvenance } from '../icc/provenance';
import { runConvert, runSample, type ConvertedPayload } from '../workers/client';
import type { EngineParams, SampleInfo } from '../color/engine';
import type { RenderingIntent } from '../color/lcms';

export type SourceStatus =
  | { kind: 'none' }
  | { kind: 'embedded'; info: ProfileInfo }
  | { kind: 'missing'; info: null }
  | { kind: 'assumed'; info: ProfileInfo; assumedFromId: string };

export interface ImportedImage {
  bytes: Uint8Array;
  name: string;
  width?: number;
  height?: number;
  bitDepth: 8 | 16;
  container: string;
  embedded: Uint8Array | null;
  provenance: { converted: boolean; detail?: string };
}

interface SamplePoint {
  x: number;
  y: number;
  info?: SampleInfo | null;
  pending?: boolean;
  error?: string;
}

let uid = 1;
export const newId = (p = 'p') => `${p}-${Date.now().toString(36)}-${uid++}`;

function createAppState() {
  const state = $state({
    ready: false as boolean,
    initError: '' as string,
    profiles: [] as StoredProfile[],
    image: null as ImportedImage | null,
    /** effective source profile bytes (embedded bytes or chosen library profile) */
    sourceProfile: null as StoredProfile | null,
    sourceEmbeddedInfo: null as ProfileInfo | null,
    sourceAssumed: false,
    targetProfile: null as StoredProfile | null,
    intent: 'relative-colorimetric' as RenderingIntent,
    blackPointCompensation: true,
    proofIntent: 'relative-colorimetric' as RenderingIntent,
    converting: false,
    convertError: '' as string,
    result: null as ConvertedPayload | null,
    /** params signature the current result was computed with */
    resultKey: '' as string,
    hover: { x: 0, y: 0, info: null as SampleInfo | null, pending: false } as SamplePoint,
    pins: [] as SamplePoint[],
    projects: [] as { id: string; name: string; updatedAt: string }[],
    busyProfiles: false,
    notice: '' as string,
    showOriginalManaged: true,
  });

  async function init() {
    try {
      await seedBuiltinProfiles();
      state.profiles = await idbAll<StoredProfile>(STORE_PROFILES);
      state.profiles.sort((a, b) => a.description.localeCompare(b.description));
      if (!state.targetProfile) {
        const wide = state.profiles.find((p) => p.id === 'builtin-ciergb-elle') ?? state.profiles[0] ?? null;
        state.targetProfile = wide;
      }
      state.projects = (await idbAll<StoredProject>(STORE_PROJECTS)).map((p: StoredProject) => ({
        id: p.id,
        name: p.name,
        updatedAt: p.updatedAt,
      }));
      state.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      state.ready = true;
    } catch (err) {
      state.initError = err instanceof Error ? err.message : String(err);
    }
  }

  async function importImage(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const container = detectContainer(bytes);
    if (container === 'unknown') {
      state.notice = '仅支持 PNG / JPEG / WebP。';
      return;
    }
    const embedded = extractEmbeddedICC(bytes);
    const provenance = detectProvenance(bytes);
    const info = embedded ? readProfileInfo(embedded) : null;
    state.image = {
      bytes,
      name: file.name,
      bitDepth: container === 'png' && bytes[24] === 16 ? 16 : 8,
      container,
      embedded,
      provenance,
    };
    state.sourceEmbeddedInfo = embedded && info?.valid ? info : null;
    state.result = null;
    state.resultKey = '';
    state.pins = [];
    state.hover.info = null;
    state.convertError = '';
    state.sourceAssumed = false;
    state.sourceProfile = null;

    if (embedded && info?.valid) {
      // Profile the pixels were actually tagged with; record identity for display.
      state.sourceProfile = {
        id: 'embedded:' + (info.profileId || file.name),
        bytes: embedded,
        description: info.description || `嵌入配置 (${info.colorSpaceSig.trim()})`,
        colorSpace: info.colorSpace,
        channels: info.channels,
        origin: 'builtin-open', // origin field semantics live in the record; UI overrides label
        addedAt: '',
        size: embedded.byteLength,
      };
    }
    // Missing profile -> no default guess; operator must choose (enforced in UI).
  }

  function chooseSourceProfile(id: string) {
    const p = state.profiles.find((x) => x.id === id);
    if (!p || !state.image) return;
    state.sourceProfile = p;
    state.sourceAssumed = !state.image.embedded;
    invalidate();
  }

  function chooseTargetProfile(id: string) {
    state.targetProfile = state.profiles.find((x) => x.id === id) ?? null;
    invalidate();
  }

  function invalidate() {
    state.result = null;
    state.resultKey = '';
    state.hover.info = null;
  }

  const paramsKey = $derived(
    state.image && state.sourceProfile && state.targetProfile
      ? [
          state.sourceProfile.id,
          state.targetProfile.id,
          state.intent,
          state.blackPointCompensation ? 1 : 0,
          state.proofIntent,
          state.image.bytes.byteLength,
        ].join('|')
      : '',
  );

  const needsSourceChoice = $derived(!!state.image && !state.image.embedded && !state.sourceAssumed);

  async function convertNow() {
    if (!state.image || !state.sourceProfile || !state.targetProfile) return;
    state.converting = true;
    state.convertError = '';
    try {
      const params: EngineParams = {
        intent: state.intent,
        blackPointCompensation: state.blackPointCompensation,
        proofIntent: state.proofIntent,
      };
      const r = await runConvert({
        imageBytes: state.image.bytes,
        sourceIcc: state.sourceProfile.bytes,
        targetIcc: state.targetProfile.bytes,
        params,
      });
      state.result = r;
      state.resultKey = paramsKey;
    } catch (err) {
      state.convertError = err instanceof Error ? err.message : String(err);
    } finally {
      state.converting = false;
    }
  }

  async function sample(x: number, y: number): Promise<SampleInfo | null> {
    if (!state.image || !state.sourceProfile || !state.targetProfile) return null;
    const params: EngineParams = {
      intent: state.intent,
      blackPointCompensation: state.blackPointCompensation,
      proofIntent: state.proofIntent,
    };
    return runSample({
      imageBytes: state.image.bytes,
      sourceIcc: state.sourceProfile.bytes,
      targetIcc: state.targetProfile.bytes,
      params,
      x,
      y,
    });
  }

  function pin(x: number, y: number) {
    const point: SamplePoint = { x, y, pending: true };
    state.pins.push(point);
    void sample(x, y)
      .then((info) => {
        point.info = info;
        point.pending = false;
      })
      .catch((err) => {
        point.error = String(err);
        point.pending = false;
      });
  }
  function removePin(i: number) {
    state.pins.splice(i, 1);
  }

  async function importProfiles(files: FileList | File[]) {
    state.busyProfiles = true;
    const added: string[] = [];
    for (const file of [...files]) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = readProfileInfo(bytes);
      if (!info.valid || (info.colorSpace !== 'RGB' && info.colorSpace !== 'CMYK' && info.colorSpace !== 'GRAY')) {
        state.notice = `已跳过 ${file.name}：不是有效的 RGB/CMYK/Gray ICC 配置。`;
        continue;
      }
      const id = newId('icc');
      const profile: StoredProfile = {
        id,
        bytes,
        description: info.description || file.name,
        colorSpace: info.colorSpace,
        channels: info.channels,
        origin: 'user-imported',
        addedAt: new Date().toISOString(),
        size: bytes.byteLength,
      };
      await idbPut(STORE_PROFILES, profile);
      added.push(profile.description);
    }
    state.profiles = await idbAll<StoredProfile>(STORE_PROFILES);
    state.profiles.sort((a, b) => a.description.localeCompare(b.description));
    state.busyProfiles = false;
    if (added.length) state.notice = `已加入配置库：${added.join('、')}`;
  }

  async function saveProject(name: string) {
    if (!state.image || !state.sourceProfile) return;
    const id = newId('proj');
    const p: StoredProject = {
      id,
      name: name || state.image.name,
      updatedAt: new Date().toISOString(),
      imageBytes: state.image.bytes,
      imageName: state.image.name,
      embeddedICC: state.image.embedded ?? undefined,
      sourceProfileId: state.sourceProfile.id.startsWith('embedded:') ? null : state.sourceProfile.id,
      sourceIsEmbedded: !!state.image.embedded,
      sourceAssumptionNote: state.sourceAssumed
        ? '原图缺少嵌入配置，操作员手动选择源配置（假设已记录）'
        : undefined,
      targetProfileId: state.targetProfile?.id ?? null,
      intent: state.intent,
      blackPointCompensation: state.blackPointCompensation,
      provenanceSeen: state.image.provenance.converted,
    };
    await idbPut(STORE_PROJECTS, p);
    state.projects = (await idbAll<StoredProject>(STORE_PROJECTS)).map((x) => ({
      id: x.id,
      name: x.name,
      updatedAt: x.updatedAt,
    }));
    state.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    state.notice = `工程已保存到本机 IndexedDB：${p.name}`;
  }

  async function loadProject(id: string) {
    const p = await idbGetProject(id);
    if (!p) return;
    const embedded = p.embeddedICC ?? null;
    state.image = {
      bytes: p.imageBytes,
      name: p.imageName,
      bitDepth: detectContainer(p.imageBytes) === 'png' && p.imageBytes[24] === 16 ? 16 : 8,
      container: detectContainer(p.imageBytes),
      embedded,
      provenance: detectProvenance(p.imageBytes),
    };
    const all = await idbAll<StoredProfile>(STORE_PROFILES);
    state.profiles = all.sort((a, b) => a.description.localeCompare(b.description));
    if (p.sourceIsEmbedded && embedded) {
      const info = readProfileInfo(embedded);
      state.sourceProfile = {
        id: 'embedded:' + (info.profileId || p.imageName),
        bytes: embedded,
        description: info.description || '嵌入配置',
        colorSpace: info.colorSpace,
        channels: info.channels,
        origin: 'builtin-open',
        addedAt: '',
        size: embedded.byteLength,
      };
      state.sourceAssumed = false;
      state.sourceEmbeddedInfo = info;
    } else if (p.sourceProfileId) {
      const sp = all.find((x) => x.id === p.sourceProfileId) ?? null;
      state.sourceProfile = sp;
      state.sourceAssumed = true;
      state.sourceEmbeddedInfo = null;
    }
    state.targetProfile = all.find((x) => x.id === p.targetProfileId) ?? null;
    state.intent = p.intent;
    state.blackPointCompensation = p.blackPointCompensation;
    invalidate();
    state.notice = `已载入工程：${p.name}`;
  }

  async function deleteProject(id: string) {
    await idbDelete(STORE_PROJECTS, id);
    state.projects = state.projects.filter((p) => p.id !== id);
  }

  async function deleteProfile(id: string) {
    if (id.startsWith('builtin-')) return;
    await idbDelete(STORE_PROFILES, id);
    state.profiles = state.profiles.filter((p) => p.id !== id);
    if (state.sourceProfile?.id === id) state.sourceProfile = null;
    if (state.targetProfile?.id === id) state.targetProfile = null;
    invalidate();
  }

  return {
    state,
    init,
    importImage,
    chooseSourceProfile,
    chooseTargetProfile,
    convertNow,
    sample,
    pin,
    removePin,
    importProfiles,
    saveProject,
    loadProject,
    deleteProject,
    deleteProfile,
    get needsSourceChoice() {
      return needsSourceChoice;
    },
    get paramsKey() {
      return paramsKey;
    },
  };
}

async function idbGetProject(id: string): Promise<StoredProject | undefined> {
  const all = await idbAll<StoredProject>(STORE_PROJECTS);
  return all.find((p) => p.id === id);
}

export type AppState = ReturnType<typeof createAppState>;

let singleton: AppState | null = null;
export function getApp(): AppState {
  singleton ??= createAppState();
  return singleton;
}

export type { ColorSpaceKind };
