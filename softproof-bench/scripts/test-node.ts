/**
 * Node-side unit tests for the pure modules: ICC parse/extract, PNG encoder
 * (incl. iCCP + provenance), TIFF CMYK encoder, and color math.
 *
 * Run: npx tsx scripts/test-node.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readProfileInfo } from '../src/lib/icc/profileInfo';
import { extractEmbeddedICC } from '../src/lib/icc/extractEmbedded';
import { encodePng } from '../src/lib/codec/png';
import { encodeTiffCmyk } from '../src/lib/codec/tiff';
import { detectProvenance } from '../src/lib/icc/provenance';
import { deltaE2000 } from '../src/lib/color/colorMath';
import { fnv1a64 } from '../src/lib/color/hash';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'test-out');
mkdirSync(outDir, { recursive: true });

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name} ${detail}`);
  }
}

console.log('# ICC profiles');
const srgbIcc = readFileSync(resolve(root, 'public/profiles/sRGB-elle-V2-srgbtrc.icc'));
const cieIcc = readFileSync(resolve(root, 'public/profiles/CIERGB-elle-V2-g22.icc'));
const cmykIcc = readFileSync(resolve('/workspace/test-assets/profiles/ISOcoated_v2_300_mth.icc'));

const sInfo = readProfileInfo(srgbIcc);
check('sRGB profile parsed', sInfo.valid && sInfo.colorSpace === 'RGB' && sInfo.channels === 3, JSON.stringify(sInfo));
check('sRGB description non-empty', sInfo.description.length > 3, sInfo.description);
const cInfo = readProfileInfo(new Uint8Array(cmykIcc));
check('CMYK profile parsed', cInfo.valid && cInfo.colorSpace === 'CMYK' && cInfo.channels === 4, cInfo.description);

console.log('# Color patch PNG (8-bit RGBA, transparent borders)');
// 4x3 image: corners fully transparent, interior solid primaries + mid gray
const W = 4,
  H = 3;
const rgba = new Uint8Array(W * H * 4);
const px = (x: number, y: number, r: number, g: number, b: number, a: number) => {
  const i = (y * W + x) * 4;
  rgba.set([r, g, b, a], i);
};
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px(x, y, 200, 200, 200, 255);
px(0, 0, 255, 0, 0, 0); // transparent corner
px(W - 1, 0, 0, 255, 0, 0);
px(0, H - 1, 0, 0, 255, 0);
px(W - 1, H - 1, 255, 255, 0, 0);
px(1, 1, 255, 0, 0, 255);
px(2, 1, 0, 255, 0, 255);
px(1, 2, 0, 0, 255, 255);
px(2, 2, 128, 128, 128, 255);

const pngBytes = encodePng({
  width: W,
  height: H,
  colorChannels: 3,
  bitDepth: 8,
  data: rgba,
  hasAlpha: true,
  icc: srgbIcc,
  iccName: 'sRGB test',
  text: {
    'softproof-bench-conversion':
      'v=1; source=test; target=CIERGB; intent=relative-colorimetric; bpc=1; this-file-is-converted-not-original=1',
  },
});
writeFileSync(resolve(outDir, 'patches.png'), pngBytes);
check('PNG signature', pngBytes.subarray(0, 8).join(',') === [137, 80, 78, 71, 13, 10, 26, 10].join(','));
const reIcc = extractEmbeddedICC(pngBytes);
check('iCCP round-trips byte-for-byte', !!reIcc && Buffer.from(reIcc).equals(Buffer.from(srgbIcc)));
const prov = detectProvenance(pngBytes);
check('provenance marker detected in PNG', prov.converted);

console.log('# 16-bit gray PNG');
const g16 = new Uint16Array(W * H);
for (let i = 0; i < g16.length; i++) g16[i] = i * 4000;
const gPng = encodePng({
  width: W,
  height: H,
  colorChannels: 1,
  bitDepth: 16,
  data: new Uint8Array(g16.buffer),
  hasAlpha: false,
  icc: srgbIcc,
});
writeFileSync(resolve(outDir, 'gray16.png'), gPng);
check('16-bit PNG produced', gPng.length > W * H * 2 + 50);

console.log('# CMYK TIFF');
const cmyk = new Uint8Array(W * H * 4);
const inks = [
  [0, 0, 0, 0],
  [255, 0, 0, 0],
  [0, 255, 0, 0],
  [0, 0, 255, 0],
  [0, 0, 0, 255],
  [10, 20, 30, 40],
  [200, 100, 50, 25],
  [0, 0, 0, 128],
  [128, 128, 128, 128],
  [5, 5, 5, 5],
  [30, 60, 90, 120],
  [255, 255, 255, 255],
];
for (let i = 0; i < W * H; i++) cmyk.set(inks[i % inks.length], i * 4);
const tif = encodeTiffCmyk({
  width: W,
  height: H,
  data: cmyk,
  channels: 4,
  icc: new Uint8Array(cmykIcc),
  description: 'softproof-bench-conversion: CMYK export test; this-file-is-converted-not-original=1',
});
writeFileSync(resolve(outDir, 'patches-cmyk.tif'), tif);
check('TIFF II header', tif[0] === 0x49 && tif[1] === 0x49);
const tProv = detectProvenance(tif);
check('provenance marker detected in TIFF', tProv.converted);

console.log('# embedded ICC extraction from JPEG / 16-bit PNG');
{
  const browserDir = resolve(root, 'test-assets/browser');
  const jpegIcc = extractEmbeddedICC(readFileSync(resolve(browserDir, 'patches-srgb.jpg')));
  check('JPEG APP2 ICC extracted', !!jpegIcc && jpegIcc!.byteLength === srgbIcc.byteLength, String(jpegIcc?.byteLength));
  if (jpegIcc) {
    const ji = readProfileInfo(jpegIcc);
    check('JPEG embedded ICC parses as sRGB', ji.valid && ji.colorSpace === 'RGB', ji.description);
  }
  const noIcc = extractEmbeddedICC(readFileSync(resolve(browserDir, 'patches-noicc.jpg')));
  check('JPEG without profile returns null', noIcc === null);
  const p16Icc = extractEmbeddedICC(readFileSync(resolve(browserDir, 'patches-srgb16.png')));
  check('16-bit PNG iCCP extracted byte-for-byte', !!p16Icc && Buffer.from(p16Icc!).equals(Buffer.from(srgbIcc)));
}

console.log('# color math');
// Black vs white CIEDE2000 ~= 100
const de = deltaE2000({ L: 0, a: 0, b: 0 }, { L: 100, a: 0, b: 0 });
check('dE00 black-white ~100', Math.abs(de - 100) < 0.01, String(de));
check('dE00 identical = 0', deltaE2000({ L: 50, a: 10, b: -10 }, { L: 50, a: 10, b: -10 }) === 0);
const h1 = fnv1a64(new Uint8Array([1, 2, 3]));
check('hash stable & hex16', h1.length === 16 && h1 === fnv1a64(new Uint8Array([1, 2, 3])) && h1 !== fnv1a64(new Uint8Array([1, 2, 4])));

// ---------------------------------------------------------------------------
console.log('# batch proofing state machine / race guards');
import {
  acceptResultCheck,
  canAddToBatch,
  canTransition,
  finalizeAttempt,
  isTerminal,
  missingConfirmations,
  recoverStatus,
} from '../src/lib/batch/guards';
import type { BatchAttempt } from '../src/lib/batch/types';

check('terminal statuses', isTerminal('succeeded') && isTerminal('failed') && isTerminal('canceled') && !isTerminal('queued'));
check(
  'refresh: only converting is resumed',
  recoverStatus('converting') === 'queued' &&
    recoverStatus('succeeded') === 'succeeded' &&
    recoverStatus('failed') === 'failed' &&
    recoverStatus('queued') === 'queued',
);
check('converted original cannot join batch', canAddToBatch(true).ok === false && canAddToBatch(false).ok === true);

check(
  'no-ICC without source stays unconfirmed',
  missingConfirmations({ embeddedProfile: null, source: null, target: {}, intent: 'x', blackPointCompensation: true }).includes(
    '源配置（图片无嵌入 ICC，必须人工确认）',
  ),
);
check(
  'embedded with all settings confirmed',
  missingConfirmations({ embeddedProfile: {}, source: {}, target: {}, intent: 'x', blackPointCompensation: true }).length === 0,
);

// late result cannot overwrite canceled / changed / succeeded items
const now = new Date().toISOString();
const baseAttempt: BatchAttempt = {
  id: 'att1',
  startedAt: now,
  finishedAt: null,
  outcome: 'running',
  settings: {
    sourceRefId: 's',
    sourceOrigin: 'embedded',
    targetRefId: 't',
    intent: 'relative-colorimetric',
    blackPointCompensation: true,
    settingsRevision: 1,
  },
  error: null,
  outputKey: null,
};
check(
  'result accepted only when converting + same attempt + same revision',
  acceptResultCheck({
    currentStatus: 'converting',
    attemptId: 'att1',
    responseAttemptId: 'att1',
    settingsRevision: 1,
    responseRevision: 1,
    successfulAttemptId: null,
  }) === null,
);
check(
  'late result for a stale attempt is rejected',
  acceptResultCheck({
    currentStatus: 'converting',
    attemptId: 'att2',
    responseAttemptId: 'att1',
    settingsRevision: 1,
    responseRevision: 1,
    successfulAttemptId: null,
  }) !== null,
);
check(
  'result after settings revision bump is rejected',
  acceptResultCheck({
    currentStatus: 'converting',
    attemptId: 'att1',
    responseAttemptId: 'att1',
    settingsRevision: 2,
    responseRevision: 1,
    successfulAttemptId: null,
  }) !== null,
);
check(
  'result after cancel is rejected',
  acceptResultCheck({
    currentStatus: 'canceled',
    attemptId: 'att1',
    responseAttemptId: 'att1',
    settingsRevision: 1,
    responseRevision: 1,
    successfulAttemptId: null,
  }) !== null,
);
check(
  'result rejected when success already stored',
  acceptResultCheck({
    currentStatus: 'converting',
    attemptId: 'att1',
    responseAttemptId: 'att1',
    settingsRevision: 1,
    responseRevision: 1,
    successfulAttemptId: 'att0',
  }) !== null,
);

// retry appends a NEW finalized attempt; failed history is preserved
const failedAttempt = finalizeAttempt(baseAttempt, { outcome: 'failed', error: 'boom', finishedAt: now });
const retryAttempt: BatchAttempt = { ...baseAttempt, id: 'att2', startedAt: now, settings: { ...baseAttempt.settings, settingsRevision: 2 } };
const retryOk = finalizeAttempt(retryAttempt, { outcome: 'succeeded', outputKey: 'item:att2', finishedAt: now });
check(
  'retry keeps old failure and records new success separately',
  failedAttempt.outcome === 'failed' &&
    failedAttempt.error === 'boom' &&
    failedAttempt.id === 'att1' &&
    retryOk.outcome === 'succeeded' &&
    retryOk.outputKey === 'item:att2' &&
    retryOk.id === 'att2',
);

check(
  'succeeded cannot transition anywhere',
  !canTransition('succeeded', 'queued') && canTransition('failed', 'queued') && canTransition('canceled', 'queued'),
);

console.log('# batch manifest links each output to its own settings');
import { buildBatchManifest } from '../src/lib/batch/manifest';
import type { BatchItemView, FrozenProfile } from '../src/lib/batch/types';

const mkProfile = (id: string, cs: 'RGB' | 'CMYK', origin: FrozenProfile['origin']): FrozenProfile => ({
  refId: id,
  description: id,
  colorSpace: cs,
  origin,
  bytes: new Uint8Array([1, 2, 3]),
  byteLength: 3,
});
const mkItem = (ordinal: number, overrides: Partial<BatchItemView>): BatchItemView => {
  const assumption = overrides.sourceIsAssumption ?? false;
  return {
    id: `item${ordinal}`,
    jobId: 'job1',
    createdAt: now,
    updatedAt: now,
    ordinal,
    imageName: `img${ordinal}.png`,
    container: 'png',
    bitDepth: 8,
    width: 4,
    height: 3,
    pixelHash: 'abc' + ordinal,
    embeddedProfile: overrides.embeddedProfile ?? null,
    provenanceConverted: false,
    source:
      overrides.source ??
      mkProfile(
        assumption ? 'builtin-srgb-elle' : 'embedded:srgb',
        'RGB',
        assumption ? 'manual-assumption' : 'embedded',
      ),
    sourceIsAssumption: assumption,
    target: mkProfile('builtin-ciergb-elle', 'RGB', 'builtin-open'),
    intent: 'relative-colorimetric',
    blackPointCompensation: true,
    proofIntent: 'relative-colorimetric',
    settingsRevision: 1,
    status: 'succeeded',
    attempts: [],
    successfulAttemptId: `att-${ordinal}`,
    error: null,
    bytesLoaded: false,
    ...overrides,
  };
};
const item1 = mkItem(0, {
  embeddedProfile: mkProfile('embedded:srgb', 'RGB', 'embedded'),
  source: mkProfile('embedded:srgb', 'RGB', 'embedded'),
  sourceIsAssumption: false,
});
const item2 = mkItem(1, { sourceIsAssumption: true });
const mkAtt = (id: string, rev: number): BatchAttempt => ({
  ...baseAttempt,
  id,
  outcome: 'succeeded',
  finishedAt: now,
  outputKey: `x:${id}`,
  settings: { ...baseAttempt.settings, settingsRevision: rev },
});
item2.attempts = [
  { ...baseAttempt, id: 'oldfailed', outcome: 'failed', error: 'first failure', finishedAt: now },
  mkAtt('att-2', 1),
];
const manifest = buildBatchManifest(
  { id: 'job1', name: '批次A' },
  [
    {
      item: item1,
      attempt: mkAtt('att-1', 1),
      outputFile: '001-img1.png',
      outputKind: 'rgb-png',
      outputBitDepth: 8,
      targetColorSpace: 'RGB',
      proofIntent: 'relative-colorimetric',
    },
    {
      item: item2,
      attempt: mkAtt('att-2', 1),
      outputFile: '002-img2.png',
      outputKind: 'rgb-png',
      outputBitDepth: 8,
      targetColorSpace: 'RGB',
      proofIntent: 'relative-colorimetric',
    },
  ],
);
check('manifest has one entry per output', manifest.entries.length === 2);
check(
  'entry 1 source is embedded',
  manifest.entries[0].source.origin === 'embedded' && manifest.entries[0].sourceAssumption.missingEmbedded === false,
);
check(
  'entry 2 source is an assumption + carries failed attempt history',
  manifest.entries[1].source.origin === 'assumed' &&
    manifest.entries[1].sourceAssumption.missingEmbedded === true &&
    manifest.entries[1].attempt.failedHistory.length === 1 &&
    manifest.entries[1].attempt.failedHistory[0].attemptId === 'oldfailed',
);
check(
  'each output references its own attempt id and file',
  manifest.entries[0].outputFile === '001-img1.png' &&
    manifest.entries[0].attemptId === 'att-1' &&
    manifest.entries[1].outputFile === '002-img2.png' &&
    manifest.entries[1].attemptId === 'att-2',
);
check('manifest records intent code + bpc', manifest.entries[0].transform.intentCode === 1 && manifest.entries[0].transform.blackPointCompensation);
// same pixel file, different assumptions => different items, not merged:
const dupA = mkItem(2, { id: 'dup-a', pixelHash: 'same-bytes', source: mkProfile('builtin-srgb-elle', 'RGB', 'manual-assumption') });
const dupB = mkItem(3, { id: 'dup-b', pixelHash: 'same-bytes', source: mkProfile('builtin-ciergb-elle', 'RGB', 'manual-assumption') });
const dupManifest = buildBatchManifest(
  { id: 'j', name: 'dup' },
  [dupA, dupB].map((it, i) => ({
    item: it,
    attempt: mkAtt(`dup-att${i}`, 1),
    outputFile: `o${i}.png`,
    outputKind: 'rgb-png' as const,
    outputBitDepth: 8 as const,
    targetColorSpace: 'RGB',
    proofIntent: 'relative-colorimetric' as const,
  })),
);
check(
  'identical pixels with different assumptions are not merged',
  dupManifest.entries.length === 2 &&
    dupManifest.entries[0].image.pixelHash === dupManifest.entries[1].image.pixelHash &&
    dupManifest.entries[0].source.id !== dupManifest.entries[1].source.id &&
    dupManifest.entries[0].itemId !== dupManifest.entries[1].itemId,
);

console.log(failures ? `\n${failures} FAILURES` : '\nALL NODE TESTS PASSED');
process.exit(failures ? 1 : 0);
