<script lang="ts">
  import type { AppState } from '../db/state.svelte';
  import { INTENT_LABEL, type RenderingIntent } from '../color/lcms';

  interface Props {
    app: AppState;
  }
  let { app }: Props = $props();
  const s = app.state;

  const intents: RenderingIntent[] = [
    'perceptual',
    'relative-colorimetric',
    'saturation',
    'absolute-colorimetric',
  ];

  let profileInput = $state<HTMLInputElement | null>(null);
  let imageInput = $state<HTMLInputElement | null>(null);

  const rgbProfiles = $derived(s.profiles.filter((p) => p.colorSpace === 'RGB' || p.colorSpace === 'GRAY'));
  const allProfiles = $derived(s.profiles);
</script>

<div class="stack">
  <div class="panel stack">
    <h2>1. 原图（仅本机，不上传）</h2>
    <input
      type="file"
      accept="image/png,image/jpeg,image/webp"
      bind:this={imageInput}
      onchange={(e) => {
        const f = (e.currentTarget as HTMLInputElement).files?.[0];
        if (f) app.importImage(f);
      }}
    />
    {#if s.image}
      <div class="small stack">
        <div><strong>{s.image.name}</strong> <span class="muted mono">{s.image.container.toUpperCase()} {s.image.bitDepth}-bit · {s.image.bytes.byteLength.toLocaleString()} B</span></div>
        {#if s.image.provenance.converted}
          <div class="danger panel-warn">
            ⚠ 该文件带有本工具的转换标记——它已经是“目标配置结果”，不应再当原图转换，避免二次转换。
            如需重转，请找回原始母版。
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if s.image}
    <div class="panel stack">
      <h2>2. 源色彩空间（先搞清图片来自哪个空间）</h2>
      {#if s.image.embedded && s.sourceEmbeddedInfo}
        <div class="row">
          <span class="badge embedded">已嵌入 ICC</span>
          <span class="badge cs-{s.sourceEmbeddedInfo.colorSpace}">{s.sourceEmbeddedInfo.colorSpace}</span>
          <span class="badge">ICC v{s.sourceEmbeddedInfo.version}</span>
        </div>
        <div class="mono small">{s.sourceProfile?.description}</div>
        <div class="muted small">转换将以该嵌入配置解释像素。也可改用库中的配置（会被记录为“假设”）：</div>
        <label class="field">
          覆盖源配置（可选）
          <select
            value={s.sourceAssumed ? s.sourceProfile?.id ?? '' : ''}
            onchange={(e) => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              if (v) app.chooseSourceProfile(v);
            }}
          >
            <option value="">使用嵌入配置（推荐）</option>
            {#each rgbProfiles as p}
              <option value={p.id}>{p.description} [{p.colorSpace}]</option>
            {/each}
          </select>
        </label>
      {:else}
        <div class="warn panel-warn">
          原图<b>缺少嵌入 ICC 配置</b>。必须先选择一个源配置——该选择会作为“假设”写入设置记录。
        </div>
        <label class="field">
          源配置（必选）
          <select
            value={s.sourceProfile?.id ?? ''}
            onchange={(e) => app.chooseSourceProfile((e.currentTarget as HTMLSelectElement).value)}
          >
            <option value="" disabled>-- 请选择源配置 --</option>
            {#each rgbProfiles as p}
              <option value={p.id}>{p.description} [{p.colorSpace}]</option>
            {/each}
          </select>
        </label>
        {#if s.sourceAssumed}
          <div class="small ok">✓ 已记录假设：{s.sourceProfile?.description}</div>
        {/if}
      {/if}
    </div>

    <div class="panel stack">
      <h2>3. 目标印厂配置与转换参数</h2>
      <label class="field">
        目标 ICC 配置
        <select
          value={s.targetProfile?.id ?? ''}
          onchange={(e) => app.chooseTargetProfile((e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="" disabled>-- 请选择目标配置 --</option>
          {#each allProfiles as p}
            <option value={p.id}>
              {p.description} [{p.colorSpace}{p.origin === 'builtin-open' ? ' · 开放内置' : ' · 用户导入'}]
            </option>
          {/each}
        </select>
      </label>
      {#if s.targetProfile}
        <div class="muted small mono">
          {s.targetProfile.colorSpace} · {s.targetProfile.size.toLocaleString()} B · {s.targetProfile.origin === 'builtin-open' ? '开放许可内置' : '用户导入'}
        </div>
      {/if}

      <label class="field">
        渲染意图（Rendering Intent）
        <select bind:value={s.intent} onchange={() => (s.result = null)}>
          {#each intents as i}
            <option value={i}>{INTENT_LABEL[i]}</option>
          {/each}
        </select>
      </label>

      <label class="row check">
        <input type="checkbox" bind:checked={s.blackPointCompensation} onchange={() => (s.result = null)} />
        <span>黑点补偿（Black Point Compensation）</span>
      </label>

      <label class="field">
        软打样模拟意图（目标→显示器，通常固定相对色度）
        <select bind:value={s.proofIntent}>
          <option value="relative-colorimetric">相对色度（标准软打样）</option>
          <option value="absolute-colorimetric">绝对色度（模拟纸白）</option>
          <option value="perceptual">感知式</option>
          <option value="saturation">饱和度</option>
        </select>
      </label>

      <button
        class="primary"
        disabled={!s.sourceProfile || !s.targetProfile || s.converting || s.image.provenance.converted}
        onclick={() => app.convertNow()}
      >
        {s.converting ? 'LittleCMS 转换中…' : '执行 ICC 转换并并排预览'}
      </button>
      {#if s.image.provenance.converted}
        <div class="small danger">已阻止：该图像带转换标记。</div>
      {/if}
      {#if s.convertError}<div class="small danger">{s.convertError}</div>{/if}
    </div>
  {/if}

  <div class="panel stack">
    <h2>ICC 配置库（本机 IndexedDB）</h2>
    <input
      type="file"
      accept=".icc,.icm"
      multiple
      bind:this={profileInput}
      onchange={(e) => {
        const fs = (e.currentTarget as HTMLInputElement).files;
        if (fs) app.importProfiles(fs);
      }}
    />
    <div class="muted small">导入印厂 RGB/CMYK/灰阶配置（.icc/.icm）。文件仅存本机。</div>
    <div class="profilelist scroll">
      {#each s.profiles as p (p.id)}
        <div class="row spread pl">
          <span class="small" title={p.id}>
            <span class="badge cs-{p.colorSpace}">{p.colorSpace}</span>
            {p.description}
          </span>
          {#if p.origin === 'user-imported'}
            <button class="ghost small" onclick={() => app.deleteProfile(p.id)}>删</button>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .panel-warn {
    border-radius: 6px;
    padding: 6px 8px;
    background: #7a5a2322;
    border: 1px solid #7a5a2355;
  }
  .check {
    font-size: 13px;
  }
  .profilelist {
    max-height: 180px;
  }
  .pl {
    padding: 3px 2px;
    border-bottom: 1px solid #ffffff08;
    gap: 6px;
  }
</style>
