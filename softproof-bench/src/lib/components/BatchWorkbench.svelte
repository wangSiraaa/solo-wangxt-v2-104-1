<script lang="ts">
  import { getBatch } from '../batch/batch.svelte';
  import type { StoredProfile } from '../db/db';
  import {
    idbAll,
    idbGet,
    idbGetAllByIndex,
    STORE_BATCH_ITEMS,
    STORE_BATCH_JOBS,
    STORE_BATCH_OUTPUTS,
    type StoredBatchItem,
    type StoredBatchJob,
    type StoredBatchOutput,
  } from '../db/db';
  import { buildBatchExport } from '../batch/batchExport';
  import { downloadBytes } from '../codec/export';
  import BatchItemCard from './BatchItemCard.svelte';
  import type { RenderingIntent } from '../color/lcms';
  import { INTENT_LABEL } from '../color/lcms';

  interface Props {
    profiles: StoredProfile[];
  }
  let { profiles }: Props = $props();
  const batch = getBatch();
  const b = batch.state;

  let newJobName = $state('');
  let newJobTarget = $state<string>('');
  let newJobIntent = $state<RenderingIntent>('relative-colorimetric');
  let newJobBpc = $state(true);
  let newJobProof = $state<RenderingIntent>('relative-colorimetric');
  let fileInput = $state<HTMLInputElement | null>(null);
  let exporting = $state(false);
  let exportMsg = $state('');

  const job = $derived(b.jobs.find((j) => j.id === b.activeJobId) ?? null);
  const rgbProfiles = $derived(profiles.filter((p) => p.colorSpace === 'RGB' || p.colorSpace === 'GRAY'));
  const allProfiles = $derived(profiles);

  const counts = $derived(
    job
      ? {
          total: job.items.length,
          needs: job.items.filter((i) => i.status === 'needs-confirmation').length,
          queued: job.items.filter((i) => i.status === 'queued' || i.status === 'converting').length,
          succeeded: job.items.filter((i) => i.status === 'succeeded').length,
          failed: job.items.filter((i) => i.status === 'failed').length,
          canceled: job.items.filter((i) => i.status === 'canceled').length,
        }
      : null,
  );

  async function createJobAndAdd(files: File[]) {
    const targetId = newJobTarget || profiles[0]?.id || null;
    const jobId = await batch.createJob({
      name: newJobName,
      targetRefId: targetId,
      intent: newJobIntent,
      blackPointCompensation: newJobBpc,
      proofIntent: newJobProof,
    });
    if (files.length) {
      const { rejected } = await batch.addFiles(jobId, files);
      if (rejected.length) b.notice = rejected.map((r) => `${r.name}：${r.reason}`).join('；');
    }
    newJobName = '';
  }

  async function onFiles(files: FileList | null) {
    if (!files || !files.length) return;
    if (!job) {
      await createJobAndAdd([...files]);
    } else {
      const { added, rejected } = await batch.addFiles(job.id, [...files]);
      if (rejected.length) b.notice = rejected.map((r) => `${r.name}：${r.reason}`).join('；');
      if (!added && !rejected.length) b.notice = '没有可加入的文件。';
    }
    if (fileInput) fileInput.value = '';
  }

  async function exportBatch() {
    if (!job) return;
    exporting = true;
    exportMsg = '';
    try {
      const [storedJob, records, outputs] = await Promise.all([
        idbGet<StoredBatchJob>(STORE_BATCH_JOBS, job.id),
        idbGetAllByIndex<StoredBatchItem>(STORE_BATCH_ITEMS, 'jobId', job.id),
        idbGetAllByIndex<StoredBatchOutput>(STORE_BATCH_OUTPUTS, 'jobId', job.id),
      ]);
      if (!storedJob) throw new Error('批次不存在');
      const { files } = buildBatchExport(storedJob, records, outputs, job.items);
      // images first, manifest last; spaced so browsers accept the downloads
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setTimeout(() => downloadBytes(f.name, f.bytes, f.mime), i * 180);
      }
      exportMsg = `已导出 ${files.length - 1} 张转换图 + 1 份批次清单（每个输出关联各自独立设置）。`;
    } catch (err) {
      exportMsg = `导出失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      exporting = false;
    }
  }

  async function removeJob() {
    if (!job) return;
    if (!confirm(`删除批次「${job.name}」及其全部原图快照与输出？`)) return;
    await batch.deleteJob(job.id);
  }
</script>

<div class="workbench">
  <div class="toolbar panel">
    <div class="stack grow">
      <h2>本机批次打样作业（图片与配置不上传，IndexedDB 可恢复）</h2>
      <div class="row wrap small muted">
        每张图冻结原图字节、源/目标配置、渲染意图与黑点补偿；无嵌入 ICC 的条目必须人工确认源配置后才入队。
      </div>
    </div>
    <div class="newjob">
      <input type="text" placeholder="新批次名称（可选）" bind:value={newJobName} />
      <select bind:value={newJobTarget}>
        <option value="">默认目标：自动（首个）</option>
        {#each allProfiles as p}
          <option value={p.id}>{p.description} [{p.colorSpace}]</option>
        {/each}
      </select>
      <select bind:value={newJobIntent}>
        {#each (['perceptual', 'relative-colorimetric', 'saturation', 'absolute-colorimetric'] as RenderingIntent[]) as i}
          <option value={i}>{INTENT_LABEL[i]}</option>
        {/each}
      </select>
      <label class="check"><input type="checkbox" bind:checked={newJobBpc} /> BPC</label>
      <input
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp"
        bind:this={fileInput}
        onchange={(e) => onFiles((e.currentTarget as HTMLInputElement).files)}
        data-testid="batch-file-input"
      />
    </div>
  </div>

  {#if b.notice}
    <button class="banner" onclick={() => batch.clearNotice()}>{b.notice}（点击关闭）</button>
  {/if}

  {#if b.jobs.length === 0}
    <div class="empty panel muted small">
      还没有批次。选择多张同一版式的原稿即可创建一个批次；带“已转换”标记的文件会被拒绝，不能作为批次原图。
    </div>
  {:else if job}
    <div class="jobbar panel">
      <div class="row spread">
        <div class="row">
          <select value={job.id} onchange={(e) => batch.selectJob((e.currentTarget as HTMLSelectElement).value)}>
            {#each b.jobs as j}
              <option value={j.id}>{j.name}（{j.items.length} 张）</option>
            {/each}
          </select>
          <button class="ghost" onclick={removeJob}>删除批次</button>
          <button class="ghost" onclick={() => batch.cancelJob(job.id)} disabled={counts?.queued === 0}>
            全部取消
          </button>
        </div>
        <div class="row">
          <button class="primary" onclick={exportBatch} disabled={exporting || counts?.succeeded === 0}>
            {exporting ? '打包中…' : `导出批次（${counts?.succeeded ?? 0} 张 + 清单）`}
          </button>
        </div>
      </div>

      <!-- batch-level frozen defaults -->
      <div class="defaults small">
        <label class="field">
          批次默认目标（仅作用于未开始/失败/取消的条目）
          <select
            value={job.defaults.targetRefId ?? ''}
            onchange={(e) => batch.setTarget(job.id, null, (e.currentTarget as HTMLSelectElement).value)}
          >
            <option value="" disabled>-- 目标 --</option>
            {#each allProfiles as p}
              <option value={p.id}>{p.description} [{p.colorSpace}]</option>
            {/each}
          </select>
        </label>
        <label class="field">
          默认意图
          <select
            value={job.defaults.intent}
            onchange={(e) =>
              batch.setIntent(job.id, null, { intent: (e.currentTarget as HTMLSelectElement).value as RenderingIntent })}
          >
            {#each (['perceptual', 'relative-colorimetric', 'saturation', 'absolute-colorimetric'] as RenderingIntent[]) as i}
              <option value={i}>{INTENT_LABEL[i]}</option>
            {/each}
          </select>
        </label>
        <label class="check bpc">
          <input
            type="checkbox"
            checked={job.defaults.blackPointCompensation}
            onchange={(e) => batch.setIntent(job.id, null, { blackPointCompensation: e.currentTarget.checked })}
          />
          默认 BPC
        </label>
      </div>

      <div class="counts small muted" data-testid="batch-counts">
        共 {counts?.total} · 待确认 {counts?.needs} · 排队/转换中 {counts?.queued} ·
        <span class="ok">成功 {counts?.succeeded}</span> · <span class="danger">失败 {counts?.failed}</span> ·
        已取消 {counts?.canceled}
      </div>
      {#if exportMsg}<div class="small ok" data-testid="export-msg">{exportMsg}</div>{/if}
    </div>

    <div class="items">
      {#each job.items as item (item.id)}
        <BatchItemCard
          {batch}
          jobId={job.id}
          {item}
          profiles={rgbProfiles}
          allProfiles={allProfiles}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .workbench {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    gap: 16px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
    min-width: 240px;
  }
  .newjob {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .newjob input[type='text'] {
    width: 170px;
  }
  .newjob select {
    width: auto;
  }
  .banner {
    padding: 8px 14px;
    background: #3a3220;
    border: 1px solid #7a5a2355;
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
  }
  .empty {
    padding: 30px;
    text-align: center;
  }
  .jobbar {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .jobbar select {
    width: auto;
    min-width: 220px;
  }
  .defaults {
    display: grid;
    grid-template-columns: 2fr 1fr auto;
    gap: 10px;
    align-items: end;
  }
  .bpc {
    padding-bottom: 6px;
    white-space: nowrap;
  }
  .items {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-right: 4px;
  }
  .wrap {
    flex-wrap: wrap;
  }
</style>
