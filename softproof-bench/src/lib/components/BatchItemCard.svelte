<script lang="ts">
  import type { BatchManager } from '../batch/batch.svelte';
  import type { BatchItemView } from '../batch/types';
  import { STATUS_LABEL } from '../batch/types';
  import type { RenderingIntent } from '../color/lcms';
  import { INTENT_LABEL } from '../color/lcms';
  import Thumb from './Thumb.svelte';

  interface Props {
    batch: BatchManager;
    jobId: string;
    item: BatchItemView;
    profiles: { id: string; description: string; colorSpace: string }[];
    allProfiles: { id: string; description: string; colorSpace: string }[];
  }
  let { batch, jobId, item, profiles, allProfiles }: Props = $props();
  const b = batch.state;

  const intents: RenderingIntent[] = [
    'perceptual',
    'relative-colorimetric',
    'saturation',
    'absolute-colorimetric',
  ];

  const locked = $derived(item.status === 'converting' || item.status === 'succeeded');
  const failedAttempts = $derived(item.attempts.filter((a) => a.outcome === 'failed'));
  const canceledAttempts = $derived(item.attempts.filter((a) => a.outcome === 'canceled'));
</script>

<div class="item card" data-status={item.status} data-item-id={item.id}>
  <div class="head">
    <Thumb jobId={jobId} itemId={item.id} size={44} />
    <div class="meta">
      <div class="name" title={item.imageName}>
        <span class="idx">#{item.ordinal + 1}</span> {item.imageName}
      </div>
      <div class="small muted mono">
        {item.container.toUpperCase()} · {item.bitDepth}-bit
        {#if item.width}· {item.width}×{item.height}{/if} · hash {item.pixelHash.slice(0, 10)}
      </div>
      <div class="src small">
        {#if item.embeddedProfile}
          <span class="badge embedded">嵌入 ICC</span>
          <span class="mono" title={item.embeddedProfile.refId}>{item.embeddedProfile.description}</span>
        {:else}
          <span class="badge assumed">无嵌入</span>
          <span class="muted">来源依据：</span>
          {#if item.source}
            <span class="assumed">人工假设 → {item.source.description}</span>
          {:else}
            <span class="danger">必须人工确认源配置，不入队</span>
          {/if}
        {/if}
      </div>
    </div>
    <div class="statuscol">
      <span class="status st-{item.status}" data-status-label>{STATUS_LABEL[item.status]}</span>
      <span class="small muted" data-attempt-count>尝试 {item.attempts.length}</span>
    </div>
  </div>

  <div class="settings small">
    {#if item.embeddedProfile}
      <label class="field">
        源配置（可改作人工假设）
        <select
          disabled={locked}
          value={item.sourceIsAssumption ? item.source?.refId ?? '' : ''}
          onchange={(e) =>
            batch.overrideEmbeddedSource(
              jobId,
              item.id,
              (e.currentTarget as HTMLSelectElement).value || null,
            )}
        >
          <option value="">使用嵌入配置（{item.embeddedProfile.description}）</option>
          {#each profiles as p}
            <option value={p.id}>{p.description} [{p.colorSpace}]</option>
          {/each}
        </select>
      </label>
    {:else}
      <label class="field">
        确认源配置（假设，必选）
        <select
          disabled={locked}
          value={item.source?.refId ?? ''}
          onchange={(e) => batch.confirmSource(jobId, item.id, (e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="" disabled>-- 请选择源配置 --</option>
          {#each profiles as p}
            <option value={p.id}>{p.description} [{p.colorSpace}]</option>
          {/each}
        </select>
      </label>
    {/if}

    <label class="field">
      目标配置
      <select
        disabled={locked}
        value={item.target?.refId ?? ''}
        onchange={(e) => batch.setTarget(jobId, item.id, (e.currentTarget as HTMLSelectElement).value)}
      >
        <option value="" disabled>-- 目标 --</option>
        {#each allProfiles as p}
          <option value={p.id}>{p.description} [{p.colorSpace}]</option>
        {/each}
      </select>
    </label>

    <label class="field">
      渲染意图
      <select
        disabled={locked}
        value={item.intent ?? 'relative-colorimetric'}
        onchange={(e) =>
          batch.setIntent(jobId, item.id, { intent: (e.currentTarget as HTMLSelectElement).value as RenderingIntent })}
      >
        {#each intents as i}
          <option value={i}>{INTENT_LABEL[i]}</option>
        {/each}
      </select>
    </label>

    <label class="bpc check">
      <input
        type="checkbox"
        disabled={locked}
        checked={!!item.blackPointCompensation}
        onchange={(e) =>
          batch.setIntent(jobId, item.id, { blackPointCompensation: (e.currentTarget as HTMLInputElement).checked })}
      />
      黑点补偿
    </label>
  </div>

  {#if item.status === 'failed' || item.error}
    <div class="reason danger small" data-reason>
      ⚠ {item.error || '转换失败'}
      {#if failedAttempts.length > 0}
        <div class="muted">失败尝试记录：{failedAttempts.map((a) => a.id.slice(-6)).join('、')}（已保留）</div>
      {/if}
    </div>
  {/if}
  {#if canceledAttempts.length > 0}
    <div class="small muted">已取消尝试 {canceledAttempts.length} 次（记录保留）。</div>
  {/if}

  <div class="actions">
    {#if item.status === 'needs-confirmation'}
      <button
        disabled={!item.source || !item.target}
        onclick={() => batch.enqueue(jobId, item.id)}
        data-action="enqueue"
      >
        确认并入队
      </button>
    {:else if item.status === 'queued'}
      <button onclick={() => batch.cancelItem(jobId, item.id)} data-action="cancel">取消排队</button>
    {:else if item.status === 'converting'}
      <button onclick={() => batch.cancelItem(jobId, item.id)} data-action="cancel">取消转换</button>
      <span class="small muted">转换中…（请求 {item.attempts.at(-1)?.workerRequestId ?? '—'}）</span>
    {:else if item.status === 'succeeded'}
      <span class="ok small" data-success>✓ 成功{#if item.width} · {item.width}×{item.height}{/if}</span>
      <span class="small muted">成功尝试 {item.successfulAttemptId?.slice(-6)}</span>
    {:else if item.status === 'failed'}
      <button class="primary" onclick={() => batch.retry(jobId, item.id)} data-action="retry">重试（新尝试）</button>
    {:else if item.status === 'canceled'}
      <button onclick={() => batch.retry(jobId, item.id)} data-action="retry">重新排队</button>
    {/if}
  </div>
</div>

<style>
  .item {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .item[data-status='succeeded'] {
    border-color: #2f6b4c88;
  }
  .item[data-status='failed'] {
    border-color: #7a303088;
  }
  .item[data-status='converting'] {
    border-color: #3a5f8a88;
  }
  .head {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .meta {
    flex: 1;
    min-width: 0;
  }
  .name {
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .idx {
    color: var(--muted);
    font-weight: 400;
  }
  .src {
    margin-top: 2px;
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .assumed {
    color: var(--warn);
  }
  .statuscol {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    white-space: nowrap;
  }
  .status {
    font-size: 12px;
    padding: 2px 10px;
    border-radius: 99px;
    border: 1px solid var(--line);
  }
  .st-needs-confirmation {
    color: var(--warn);
    border-color: #7a5a23;
  }
  .st-queued {
    color: #9ecbff;
  }
  .st-converting {
    color: #7fd3ff;
    border-color: #3a5f8a;
  }
  .st-succeeded {
    color: var(--accent-2);
    border-color: #2f6b4c;
  }
  .st-failed {
    color: var(--danger);
    border-color: #7a3030;
  }
  .st-canceled {
    color: var(--muted);
  }
  .settings {
    display: grid;
    grid-template-columns: 2fr 2fr 1.4fr auto;
    gap: 8px;
    align-items: end;
  }
  .bpc {
    padding-bottom: 6px;
    white-space: nowrap;
  }
  .reason {
    background: #7a303018;
    border: 1px solid #7a303055;
    border-radius: 6px;
    padding: 5px 8px;
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
</style>
