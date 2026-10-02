<script lang="ts">
  import type { AppState } from '../db/state.svelte';
  import { buildExport, downloadBytes } from '../codec/export';
  import { fnv1a64 } from '../color/hash';
  import {
    APP_VERSION,
    DISCLAIMER,
    RECORD_FORMAT,
    type SettingsRecord,
  } from '../color/record';
  import { INTENT_VALUE } from '../color/lcms';

  let { app }: { app: AppState } = $props();
  const s = app.state;
  let exporting = $state(false);
  let exportMsg = $state('');

  async function doExport() {
    if (!s.image || !s.sourceProfile || !s.targetProfile || !s.result) return;
    exporting = true;
    exportMsg = '';
    try {
      const embedded = !!s.image.embedded;
      const record: SettingsRecord = {
        recordFormat: RECORD_FORMAT,
        createdAt: new Date().toISOString(),
        application: { name: 'softproof-bench', version: APP_VERSION },
        image: {
          name: s.image.name,
          width: s.result.width,
          height: s.result.height,
          bitDepth: s.result.bitDepth,
          container: s.image.container,
          pixelHash: fnv1a64(s.image.bytes),
        },
        source: {
          id: s.sourceProfile.id,
          description: embedded && !s.sourceAssumed ? `嵌入：${s.sourceProfile.description}` : s.sourceProfile.description,
          colorSpace: s.sourceProfile.colorSpace,
          origin: embedded && !s.sourceAssumed ? 'embedded' : s.sourceProfile.id.startsWith('builtin-') ? 'builtin' : 'user-library',
          byteLength: s.sourceProfile.size,
        },
        sourceAssumption: {
          missingEmbedded: !embedded,
          assumedProfile: !embedded
            ? {
                id: s.sourceProfile.id,
                description: s.sourceProfile.description,
                colorSpace: s.sourceProfile.colorSpace,
                origin: s.sourceProfile.id.startsWith('builtin-') ? 'builtin' : 'user-library',
                byteLength: s.sourceProfile.size,
              }
            : undefined,
          note: !embedded ? '原图缺少嵌入配置；由操作员选择该配置作为源空间假设。' : undefined,
        },
        target: {
          id: s.targetProfile.id,
          description: s.targetProfile.description,
          colorSpace: s.targetProfile.colorSpace,
          origin: s.targetProfile.origin === 'builtin-open' ? 'builtin' : 'user-library',
          byteLength: s.targetProfile.size,
        },
        transform: {
          intent: s.intent,
          intentCode: INTENT_VALUE[s.intent],
          blackPointCompensation: s.blackPointCompensation,
          proofIntent: s.proofIntent,
          proofIntentCode: INTENT_VALUE[s.proofIntent],
        },
        // filled by buildExport
        export: { kind: 'rgb-png', bitDepth: s.result.bitDepth, embedsTargetICC: true, fileName: '' },
        disclaimer: DISCLAIMER,
      };

      const base = s.image.name.replace(/\.[^.]+$/, '') || 'image';
      const files = await buildExport({
        converted: s.result,
        targetIcc: s.targetProfile.bytes,
        targetIccName: s.targetProfile.description,
        baseName: base,
        record,
      });
      downloadBytes(files.image.name, files.image.bytes, files.image.mime);
      setTimeout(() => downloadBytes(files.json.name, files.json.bytes, 'application/json'), 150);
      exportMsg = `已导出：${files.image.name} 与设置记录 ${files.json.name}`;
    } catch (err) {
      exportMsg = `导出失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      exporting = false;
    }
  }
</script>

<div class="panel spread-row">
  <div class="stack">
    <h2>4. 导出（图像与设置记录分别标识配置）</h2>
    <div class="small muted">
      {#if s.result}
        {s.result.targetColorSpace === 'CMYK'
          ? '将导出 8-bit CMYK TIFF（嵌入目标 ICC，ImageDescription 含转换标记）'
          : `将导出 ${s.result.bitDepth}-bit ${s.result.targetColorSpace === 'GRAY' ? '灰阶' : 'RGB'} PNG（iCCP 嵌入目标 ICC，tEXt 含转换标记）`}
        ；另存 JSON 设置记录。
      {:else}
        执行转换后可导出。导出文件带“已转换，非原图”标记。
      {/if}
    </div>
    {#if exportMsg}<div class="small ok">{exportMsg}</div>{/if}
  </div>
  <button class="primary" disabled={!s.result || exporting} onclick={doExport}>
    {exporting ? '打包中…' : '导出转换图像 + 设置记录'}
  </button>
</div>

<style>
  .spread-row {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  }
</style>
