<script lang="ts">
  import type { AppState } from '../db/state.svelte';
  let { app }: { app: AppState } = $props();
  const s = app.state;
  let name = $state('');
</script>

<div class="panel stack">
  <h2>本机工程（IndexedDB）</h2>
  <div class="row">
    <input type="text" placeholder="工程名称（可选）" bind:value={name} />
    <button onclick={() => app.saveProject(name)} disabled={!s.image || !s.sourceProfile}>保存工程</button>
  </div>
  {#if s.projects.length === 0}
    <div class="small muted">尚无保存的工程。图片与配置不会上传，全部保存在此浏览器内。</div>
  {:else}
    <div class="projlist scroll">
      {#each s.projects as p (p.id)}
        <div class="row spread pl">
          <button class="ghost left" onclick={() => app.loadProject(p.id)} title="载入工程">
            <span>{p.name}</span>
            <span class="small muted">{new Date(p.updatedAt).toLocaleString()}</span>
          </button>
          <button class="ghost small danger" onclick={() => app.deleteProject(p.id)}>删</button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .projlist {
    max-height: 160px;
  }
  .pl {
    border-bottom: 1px solid #ffffff08;
    gap: 6px;
  }
  .left {
    text-align: left;
    display: flex;
    flex-direction: column;
    flex: 1;
  }
</style>
