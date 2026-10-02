<script lang="ts">
  import type { AppState } from '../db/state.svelte';
  import { getBatchStore, type ReconfigurePatch } from '../batch/batchStore.svelte';
  import { STATUS_LABEL, type StoredBatchItem } from '../batch/types';
  import { INTENT_LABEL, type RenderingIntent } from '../color/lcms';

  let { app }: { app: AppState } = $props();
  const s = app.state;
  const batch = getBatchStore();
  const bs = batch.state;

  const rgbProfiles = $derived(s.profiles.filter((p) => p.colorSpace === 'RGB' || p.colorSpace === 'GRAY'));
  const allProfiles = $derived(s.profiles);
  const active = $derived(bs.batches.find((b) => b.id === bs.activeBatchId) ?? null);
  const succeededCount = $derived(bs.items.filter((x) => x.status === 'succeeded').length);
  const counts = $derived(
    (['pending-confirm', 'queued', 'converting', 'succeeded', 'failed', 'cancelled'] as const).map(
      (st) => ({ st, n: bs.items.filter((x) => x.status === st).length }),
    ),
  );

  const intents: RenderingIntent[] = [
    'perceptual',
    'relative-colorimetric',
    'saturation',
    'absolute-colorimetric',
  ];

  let newName = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  /** chosen source profile per pending-confirm item */
  let confirmChoice = $state<Record<string, string>>({});
  /** reconfigure editor */
  let editingId = $state<string | null>(null);
  let editSource = $state('');
  let editTarget = $state('');
  let editIntent = $state<RenderingIntent>('relative-colorimetric');
  let editBpc = $state(true);
  let editProof = $state<RenderingIntent>('relative-colorimetric');

  function fmtTime(iso: string): string {
    return iso ? new Date(iso).toLocaleString() : '';
  }

  async function createBatch() {
    await batch.createBatch(newName, {
      targetProfileId: s.targetProfile?.id ?? null,
      intent: s.intent,
      blackPointCompensation: s.blackPointCompensation,
      proofIntent: s.proofIntent,
    });
    newName = '';
  }

  function onFiles(e: Event) {
    const fs = (e.currentTarget as HTMLInputElement).files;
    if (fs?.length) void batch.addFiles([...fs], s.profiles);
    (e.currentTarget as HTMLInputElement).value = '';
  }

  function startEdit(item: StoredBatchItem) {
    editingId = item.id;
    editSource = item.source?.kind === 'assumed' ? (item.source.profileId ?? '') : 'embedded';
    editTarget = item.target.targetProfileId;
    editIntent = item.target.intent;
    editBpc = item.target.blackPointCompensation;
    editProof = item.target.proofIntent;
  }

  async function applyEdit(item: StoredBatchItem) {
    const patch: ReconfigurePatch = {
      sourceProfileId: editSource,
      targetProfileId: editTarget,
      intent: editIntent,
      blackPointCompensation: editBpc,
      proofIntent: editProof,
    };
    await batch.reconfigure(item.id, patch, s.profiles);
    editingId = null;
  }
</script>

<div class="batch-wrap">
  {#if bs.notice}
    <button class="banner batch-notice" onclick={() => (bs.notice = '')}>{bs.notice}（点击关闭）</button>
  {/if}
  <div class="batch-columns">
    <aside class="batch-side stack">
      <div class="panel stack">
        <h2>批次（IndexedDB 持久化，可恢复）</h2>
        <div class="row">
          <input type="text" placeholder="新批次名称（可选）" bind:value={newName} />
          <button onclick={createBatch}>新建批次</button>
        </div>
        {#if bs.batches.length === 0}
          <div class="small muted">
            印厂一次交来同一版式的多张原稿时，在此建一个批次：每张图冻结原图字节与各自的源/目标配置、
            渲染意图、黑点补偿；刷新页面后未完成的条目会继续处理。
          </div>
        {:else}
          <div class="batchlist scroll">
            {#each bs.batches as b (b.id)}
              <div class="row spread bl">
                <button
                  class="ghost left batch-row"
                  class:current={b.id === bs.activeBatchId}
                  onclick={() => batch.selectBatch(b.id)}
                >
                  <span>{b.name}</span>
                  <span class="small muted">{fmtTime(b.createdAt)}</span>
                </button>
                <button class="ghost small danger" title="删除批次及其全部条目" onclick={() => batch.deleteBatch(b.id)}>删</button>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      {#if active}
        <div class="panel stack">
          <h2>批次默认（仅作用于之后加入的条目）</h2>
          <label class="field">
            目标 ICC 配置
            <select
              value={active.defaults.targetProfileId ?? ''}
              onchange={(e) =>
                batch.updateDefaults({ ...active.defaults, targetProfileId: (e.currentTarget as HTMLSelectElement).value })}
            >
              {#each allProfiles as p}
                <option value={p.id}>{p.description} [{p.colorSpace}]</option>
              {/each}
            </select>
          </label>
          <label class="field">
            渲染意图
            <select
              value={active.defaults.intent}
              onchange={(e) =>
                batch.updateDefaults({ ...active.defaults, intent: (e.currentTarget as HTMLSelectElement).value as RenderingIntent })}
            >
              {#each intents as i}
                <option value={i}>{INTENT_LABEL[i]}</option>
              {/each}
            </select>
          </label>
          <label class="row check">
            <input
              type="checkbox"
              checked={active.defaults.blackPointCompensation}
              onchange={(e) =>
                batch.updateDefaults({ ...active.defaults, blackPointCompensation: (e.currentTarget as HTMLInputElement).checked })}
            />
            <span>黑点补偿（BPC）</span>
          </label>
          <label class="field">
            软打样模拟意图
            <select
              value={active.defaults.proofIntent}
              onchange={(e) =>
                batch.updateDefaults({ ...active.defaults, proofIntent: (e.currentTarget as HTMLSelectElement).value as RenderingIntent })}
            >
              <option value="relative-colorimetric">相对色度（标准软打样）</option>
              <option value="absolute-colorimetric">绝对色度（模拟纸白）</option>
              <option value="perceptual">感知式</option>
              <option value="saturation">饱和度</option>
            </select>
          </label>
          <div class="small muted">已加入的条目保留各自冻结的设置，不随此处修改变化。</div>
        </div>
      {/if}
    </aside>

    <section class="batch-main stack">
      {#if !active}
        <div class="panel muted">请先新建一个批次，然后把同一版式的多张原稿一起加入。</div>
      {:else}
        <div class="panel spread-row">
          <div class="stack">
            <h2>「{active.name}」条目队列</h2>
            <div class="small muted statusline">
              {#each counts as c}
                <span class="badge st-{c.st}">{STATUS_LABEL[c.st]} {c.n}</span>
              {/each}
              {#if bs.running}<span class="badge st-converting">队列处理中…</span>{/if}
            </div>
          </div>
          <div class="row">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              class="filehidden"
              bind:this={fileInput}
              onchange={onFiles}
            />
            <button class="primary" onclick={() => fileInput?.click()}>添加原稿（可多选）</button>
            <button disabled={succeededCount === 0 || bs.exporting} onclick={() => batch.exportBatch()}>
              {bs.exporting ? '打包中…' : '导出批次清单'}
            </button>
          </div>
        </div>

        {#if bs.items.length === 0}
          <div class="panel muted small">
            尚无条目。加入原稿后：带嵌入 ICC 的直接排队转换；缺少 ICC 的停在“待确认”，必须人工指定源配置；
            带本工具转换标记的文件会被拒绝，不能当作新原图。
          </div>
        {/if}

        {#each bs.items as item (item.id)}
          <div class="panel batch-item" data-status={item.status}>
            <div class="row spread">
              <div class="row itemhead">
                <span class="badge st-{item.status}">{STATUS_LABEL[item.status]}</span>
                <strong>{item.name}</strong>
                <span class="muted small mono">
                  {item.container.toUpperCase()} {item.bitDepth}-bit · {item.imageBytes.byteLength.toLocaleString()} B · #{item.imageHash.slice(0, 8)}
                </span>
              </div>
              <div class="row actions">
                {#if item.status === 'queued' || item.status === 'converting'}
                  <button class="ghost small" onclick={() => batch.cancel(item.id)}>取消</button>
                {/if}
                {#if item.status === 'failed' || item.status === 'cancelled'}
                  <button class="ghost small" onclick={() => batch.retry(item.id)}>重试</button>
                {/if}
                {#if item.status !== 'converting' && item.status !== 'pending-confirm'}
                  <button
                    class="ghost small"
                    onclick={() => {
                      if (editingId === item.id) editingId = null;
                      else startEdit(item);
                    }}
                  >
                    重新配置
                  </button>
                {/if}
                {#if item.status === 'succeeded'}
                  <button class="ghost small" onclick={() => batch.exportItem(item.id)}>下载输出</button>
                {/if}
                <button class="ghost small danger" onclick={() => batch.removeItem(item.id)}>移除</button>
              </div>
            </div>

            <div class="small src-basis">
              来源依据：
              {#if item.source?.kind === 'embedded'}
                <span class="badge embedded">嵌入 ICC</span>
                <span class="mono">{item.source.description}</span>
                <span class="muted">（{item.source.colorSpace}，随条目冻结）</span>
              {:else if item.source?.kind === 'assumed'}
                <span class="badge assumed">人工假设</span>
                <span class="mono">{item.source.description}</span>
                <span class="muted">（{item.source.colorSpace} · {item.source.assumptionNote}）</span>
              {:else}
                <span class="warn">原图缺少嵌入 ICC，尚未确认源配置——确认前不会进入队列。</span>
              {/if}
            </div>

            <div class="small muted settings-snap">
              设置快照：目标 {item.target.targetDescription} [{item.target.targetColorSpace}] ·
              意图 {item.target.intent} · BPC {item.target.blackPointCompensation ? '开' : '关'} ·
              打样意图 {item.target.proofIntent}
            </div>

            {#if item.status === 'pending-confirm'}
              <div class="row confirmrow">
                <select class="confirm-select" onchange={(e) => (confirmChoice[item.id] = (e.currentTarget as HTMLSelectElement).value)}>
                  <option value="" disabled selected>-- 请选择源配置（作为假设记录）--</option>
                  {#each rgbProfiles as p}
                    <option value={p.id}>{p.description} [{p.colorSpace}]</option>
                  {/each}
                </select>
                <button
                  class="primary"
                  disabled={!confirmChoice[item.id]}
                  onclick={() => batch.confirmSource(item.id, confirmChoice[item.id], s.profiles)}
                >
                  确认源配置并入队
                </button>
              </div>
            {/if}

            {#if item.status === 'failed'}
              <div class="small danger error-info">失败原因：{item.lastError || '未知错误'}</div>
            {/if}
            {#if item.status === 'succeeded' && item.result}
              <div class="small ok result-info">
                当前结果：{item.result.targetColorSpace} · {item.result.width}×{item.result.height} ·
                {item.result.bitDepth}-bit · 完成于 {fmtTime(item.result.finishedAt)}
              </div>
            {/if}

            {#if editingId === item.id}
              <div class="editgrid">
                <label class="field">
                  源配置
                  <select bind:value={editSource}>
                    {#if item.embeddedIcc}<option value="embedded">使用嵌入配置</option>{/if}
                    {#each rgbProfiles as p}
                      <option value={p.id}>假设：{p.description} [{p.colorSpace}]</option>
                    {/each}
                  </select>
                </label>
                <label class="field">
                  目标配置
                  <select bind:value={editTarget}>
                    {#each allProfiles as p}
                      <option value={p.id}>{p.description} [{p.colorSpace}]</option>
                    {/each}
                  </select>
                </label>
                <label class="field">
                  渲染意图
                  <select bind:value={editIntent}>
                    {#each intents as i}
                      <option value={i}>{INTENT_LABEL[i]}</option>
                    {/each}
                  </select>
                </label>
                <label class="field">
                  软打样模拟意图
                  <select bind:value={editProof}>
                    <option value="relative-colorimetric">相对色度</option>
                    <option value="absolute-colorimetric">绝对色度</option>
                    <option value="perceptual">感知式</option>
                    <option value="saturation">饱和度</option>
                  </select>
                </label>
                <label class="row check">
                  <input type="checkbox" bind:checked={editBpc} />
                  <span>黑点补偿</span>
                </label>
                <div class="row">
                  <button class="primary" onclick={() => applyEdit(item)}>应用并重新排队</button>
                  <button class="ghost" onclick={() => (editingId = null)}>收起</button>
                </div>
              </div>
            {/if}

            {#if item.attempts.length}
              <details class="attempts">
                <summary class="small muted">尝试记录（{item.attempts.length}）</summary>
                {#each item.attempts as a, i (a.id)}
                  <div class="small mono attempt">
                    #{i + 1} {fmtTime(a.startedAt)}
                    → {a.outcome === 'succeeded' ? '成功' : a.outcome === 'failed' ? '失败' : a.outcome === 'cancelled' ? '已取消/中断' : '进行中'}
                    {a.error ? ` · ${a.error}` : ''}
                  </div>
                {/each}
              </details>
            {/if}
          </div>
        {/each}
      {/if}
    </section>
  </div>
</div>

<style>
  .batch-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .batch-notice {
    padding: 8px 16px;
    background: #3a3220;
    border: none;
    border-bottom: 1px solid var(--line);
    text-align: left;
    width: 100%;
    cursor: pointer;
  }
  .batch-columns {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 340px 1fr;
    gap: 12px;
    padding: 12px;
    overflow: auto;
  }
  .batch-side {
    min-height: 0;
    align-content: start;
  }
  .batch-main {
    min-width: 0;
    align-content: start;
  }
  .batchlist {
    max-height: 200px;
  }
  .bl {
    border-bottom: 1px solid #ffffff08;
    gap: 6px;
  }
  .batch-row {
    text-align: left;
    display: flex;
    flex-direction: column;
    flex: 1;
  }
  .batch-row.current {
    color: var(--accent);
  }
  .spread-row {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  }
  .statusline {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .filehidden {
    display: none;
  }
  .itemhead {
    flex-wrap: wrap;
  }
  .actions {
    flex-shrink: 0;
  }
  .batch-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .confirmrow {
    gap: 8px;
  }
  .confirm-select {
    flex: 1;
  }
  .editgrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 8px;
    border-top: 1px solid var(--line);
    padding-top: 8px;
  }
  .attempts {
    border-top: 1px solid #ffffff10;
    padding-top: 4px;
  }
  .attempt {
    padding: 2px 0 2px 8px;
    color: var(--muted);
  }
  .check {
    font-size: 13px;
  }
  .badge.st-pending-confirm {
    color: var(--warn);
    border-color: #7a5a23;
  }
  .badge.st-queued {
    color: var(--accent);
  }
  .badge.st-converting {
    color: var(--accent);
    border-color: var(--accent);
  }
  .badge.st-succeeded {
    color: var(--accent-2);
    border-color: #2f6b4c;
  }
  .badge.st-failed {
    color: var(--danger);
    border-color: #6b2f2f;
  }
  .badge.st-cancelled {
    color: var(--muted);
  }
</style>
