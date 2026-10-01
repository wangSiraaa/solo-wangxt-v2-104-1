<script lang="ts">
  import { getApp } from './lib/db/state.svelte';
  import ProfilePanel from './lib/components/ProfilePanel.svelte';
  import ProjectsPanel from './lib/components/ProjectsPanel.svelte';
  import CanvasView from './lib/components/CanvasView.svelte';
  import Sampler from './lib/components/Sampler.svelte';
  import ExportBar from './lib/components/ExportBar.svelte';
  import { PROFILE_ATTRIBUTION } from './lib/db/builtinProfiles';
  import type { SampleInfo } from './lib/color/engine';

  const app = getApp();
  const s = app.state;
  app.init();

  // Original pixels rendered as-is (jsquash raw RGBA; the browser is not asked
  // to convert). The transform itself always goes through the worker.
  let originalRGBA = $state<Uint8Array | null>(null);
  let origDims = $state({ w: 0, h: 0 });
  let lastImageKey = '';

  $effect(() => {
    if (!s.image) {
      originalRGBA = null;
      return;
    }
    const key = s.image.name + s.image.bytes.byteLength;
    if (key === lastImageKey && originalRGBA) return;
    lastImageKey = key;
    let cancelled = false;
    void (async () => {
      try {
        const { decodeImage } = await import('./lib/codec/decode');
        const d = await decodeImage(s.image!.bytes);
        if (cancelled) return;
        if (d.channels === 4) {
          originalRGBA = d.data;
        } else {
          const out = new Uint8Array(d.width * d.height * 4);
          for (let i = 0; i < d.width * d.height; i++) {
            out[i * 4] = d.data[i * d.channels];
            out[i * 4 + 1] = d.data[i * d.channels + 1] ?? d.data[i * d.channels];
            out[i * 4 + 2] = d.data[i * d.channels + 2] ?? d.data[i * d.channels];
            out[i * 4 + 3] = 255;
          }
          originalRGBA = out;
        }
        origDims = { w: d.width, h: d.height };
      } catch {
        originalRGBA = null;
      }
    })();
    return () => (cancelled = true);
  });

  // Hover sampler: debounce requests while the pointer moves.
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverSeq = 0;
  function onMove(x: number, y: number) {
    s.hover.x = x;
    s.hover.y = y;
    s.hover.pending = true;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(async () => {
      const seq = ++hoverSeq;
      try {
        const info = await app.sample(x, y);
        if (seq === hoverSeq) s.hover.info = info as SampleInfo | null;
      } catch {
        if (seq === hoverSeq) s.hover.info = null;
      } finally {
        if (seq === hoverSeq) s.hover.pending = false;
      }
    }, 60);
  }
  function onLeave() {
    clearTimeout(hoverTimer);
    s.hover.info = null;
    s.hover.pending = false;
  }

  function clearNotice() {
    s.notice = '';
  }
</script>

<main class="layout">
  <header>
    <div class="brand">
      <span class="logo">▨</span>
      <div>
        <h1>纯浏览器软打样台 <span class="ver">Soft-Proof Bench</span></h1>
        <div class="tagline">LittleCMS(WebAssembly) ICC 转换 · Svelte/TypeScript · Canvas 预览 · IndexedDB 工程 · 图片不上传</div>
      </div>
    </div>
    <div class="disc" role="note">
      未经校准/特征化的显示器上，软打样不承诺等同实物打样；本工具先确认图片的源色彩空间，再呈现转换到印厂配置后的变化。
    </div>
  </header>

  {#if s.initError}
    <div class="banner danger">初始化失败：{s.initError}</div>
  {/if}
  {#if s.notice}
    <button class="banner" onclick={clearNotice}>{s.notice}（点击关闭）</button>
  {/if}

  {#if !s.ready}
    <div class="loading">正在加载 LittleCMS WASM 与内置开放配置…</div>
  {:else}
    <div class="columns">
      <aside class="sidebar scroll">
        <ProfilePanel {app} />
        <ProjectsPanel {app} />
        <div class="panel small muted attribution">{PROFILE_ATTRIBUTION}</div>
      </aside>

      <section class="content">
        <div class="canvases">
          <CanvasView
            title="原图（原始像素）"
            subtitle={s.image
              ? (s.image.embedded
                  ? '解释自嵌入 ICC'
                  : s.sourceAssumed
                    ? `按假设：${s.sourceProfile?.description}`
                    : '未确定源配置')
              : '未导入'}
            width={origDims.w}
            height={origDims.h}
            rgba={originalRGBA}
            displayMode="original"
            pins={s.pins}
            hover={{ x: s.hover.x, y: s.hover.y }}
            onmove={onMove}
            onleave={onLeave}
            onpin={(x, y) => app.pin(x, y)}
            accent="#8fd3ff"
          />
          <CanvasView
            title="转换预览（软打样）"
            subtitle={s.targetProfile
              ? `${s.targetProfile.description} · ${s.intent} · BPC ${s.blackPointCompensation ? '开' : '关'}`
              : ''}
            width={s.result?.width ?? 0}
            height={s.result?.height ?? 0}
            rgba={s.result?.softProofRGBA ?? null}
            displayMode="softproof"
            pins={s.pins}
            hover={{ x: s.hover.x, y: s.hover.y }}
            onmove={onMove}
            onleave={onLeave}
            onpin={(x, y) => app.pin(x, y)}
            accent="#ffb454"
          />
        </div>
        <ExportBar {app} />
      </section>

      <aside class="rightbar scroll">
        <Sampler
          hover={s.hover}
          pins={s.pins.map((p) => ({ x: p.x, y: p.y, info: p.info ?? null, pending: p.pending, error: p.error }))}
          onremove={(i: number) => app.removePin(i)}
        />
        <div class="panel stack">
          <h2>流程纪律</h2>
          <ol class="small rules">
            <li>先看原图有没有嵌入配置；没有则必须人工指定源配置，假设写入记录。</li>
            <li>再选印厂目标配置、渲染意图与黑点补偿。</li>
            <li>右侧为目标→显示器的软打样模拟；只用于预览，不回灌转换。</li>
            <li>导出图像嵌入目标 ICC 并带“已转换”标记；设置记录单独成文件。</li>
            <li>再次导入带标记文件会被拦截，防止二次转换。</li>
          </ol>
        </div>
      </aside>
    </div>
  {/if}
</main>

<style>
  .layout {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    gap: 16px;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  .brand {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .logo {
    font-size: 30px;
    color: var(--accent);
  }
  h1 {
    font-size: 17px;
    margin: 0;
  }
  .ver {
    font-size: 11px;
    color: var(--muted);
    font-weight: 400;
  }
  .tagline {
    font-size: 11.5px;
    color: var(--muted);
  }
  .disc {
    margin-left: auto;
    max-width: 46%;
    font-size: 11.5px;
    color: var(--warn);
    border: 1px solid #7a5a2355;
    background: #7a5a2318;
    border-radius: 8px;
    padding: 6px 10px;
  }
  .banner {
    padding: 8px 16px;
    background: #3a3220;
    border: none;
    border-bottom: 1px solid var(--line);
    text-align: left;
    width: 100%;
    cursor: pointer;
  }
  .banner.danger {
    background: #3a2020;
    cursor: default;
  }
  .loading {
    padding: 40px;
    text-align: center;
    color: var(--muted);
  }
  .columns {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 320px 1fr 360px;
    gap: 12px;
    padding: 12px;
  }
  .sidebar,
  .rightbar {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
  }
  .content {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
  }
  .canvases {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .attribution {
    margin-top: auto;
  }
  .rules {
    margin: 0;
    padding-left: 18px;
  }
  .rules li {
    margin-bottom: 5px;
  }
</style>
