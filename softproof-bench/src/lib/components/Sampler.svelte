<script lang="ts">
  import { deltaE2000, rgbHex, fromTriple, type Lab } from '../color/colorMath';
  import type { SampleInfo } from '../color/engine';

  interface Props {
    hover: { x: number; y: number; info?: SampleInfo | null | undefined; pending?: boolean };
    pins: { x: number; y: number; info?: SampleInfo | null | undefined; pending?: boolean; error?: string }[];
    onremove?: (i: number) => void;
  }
  let { hover, pins, onremove }: Props = $props();

  const fmtDev = (v: number, cs: string): string => {
    if (cs === 'CMYK') return `${v.toFixed(1)}`; // LittleCMS double CMYK runs 0..100
    return `${(v * 100).toFixed(1)}%`;
  };
  const dev8 = (v: number, cs: string): number =>
    cs === 'CMYK' ? Math.round((v / 100) * 255) : Math.round(v * 255);

  const channelsLabel = (cs: string): string[] =>
    cs === 'CMYK' ? ['C', 'M', 'Y', 'K'] : cs === 'GRAY' ? ['K(灰)'] : ['R', 'G', 'B'];

  const lab = (t: [number, number, number]): Lab => fromTriple(t);

  function hexOf(s: SampleInfo, side: 'source' | 'target'): string | null {
    const cs = side === 'source' ? s.sourceColorSpace : s.targetColorSpace;
    const d = side === 'source' ? s.sourceDevice : s.targetDevice;
    if (cs !== 'RGB') return null;
    return rgbHex(dev8(d[0], 'RGB'), dev8(d[1], 'RGB'), dev8(d[2], 'RGB'));
  }
</script>

<div class="panel stack">
  <h2>像素取样（原 / 目标）</h2>

  <div class="samplebox">
    <div class="small muted">悬停坐标 {hover.x}, {hover.y}</div>
    {#if hover.pending}
      <div class="small muted">计算中…</div>
    {:else if hover.info}
      {@render sampleBody(hover.info)}
    {:else}
      <div class="small muted">在任一画布上移动鼠标查看数值；单击可钉选。</div>
    {/if}
  </div>

  {#if pins.length > 0}
    <div class="divider"></div>
    <div class="stack">
      {#each pins as p, i (i)}
        <div class="pinbox">
          <div class="row spread">
            <span class="small muted">#{i + 1} ({p.x}, {p.y})</span>
            <button class="ghost small" onclick={() => onremove?.(i)}>移除</button>
          </div>
          {#if p.pending}
            <div class="small muted">计算中…</div>
          {:else if p.error}
            <div class="small danger">{p.error}</div>
          {:else if p.info}
            {@render sampleBody(p.info)}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#snippet sampleBody(s: SampleInfo)}
  {@const srcCh = channelsLabel(s.sourceColorSpace)}
  {@const dstCh = channelsLabel(s.targetColorSpace)}
  {@const de = deltaE2000(lab(s.sourceLab), lab(s.targetLab))}
  {@const srcHex = hexOf(s, 'source')}
  {@const dstHex = hexOf(s, 'target')}
  <div class="stack samplegrid">
    <table>
      <thead>
        <tr>
          <th></th>
          <th>源（{s.sourceColorSpace}）</th>
          <th>目标（{s.targetColorSpace}）</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="muted">设备值</td>
          <td class="mono">
            {#each srcCh as c, i}
              <span class="chip">{c} {fmtDev(s.sourceDevice[i], s.sourceColorSpace)}</span>
            {/each}
            {#if srcHex}<div class="swatch" style={`background:${srcHex}`}>{srcHex}</div>{/if}
          </td>
          <td class="mono">
            {#each dstCh as c, i}
              <span class="chip">{c} {fmtDev(s.targetDevice[i], s.targetColorSpace)}</span>
            {/each}
            {#if dstHex}<div class="swatch" style={`background:${dstHex}`}>{dstHex}</div>{/if}
          </td>
        </tr>
        <tr>
          <td class="muted">Lab（double）</td>
          <td class="mono">{s.sourceLab.map((v) => v.toFixed(2)).join('  ')}</td>
          <td class="mono">{s.targetLab.map((v) => v.toFixed(2)).join('  ')}</td>
        </tr>
        <tr>
          <td class="muted">Alpha</td>
          <td class="mono" colspan="2">{s.alpha8} / 255</td>
        </tr>
      </tbody>
    </table>
    <div class="row spread de">
      <span class="muted small">色差 ΔE00（源/目标 Lab，D50）</span>
      <strong class:warn={de >= 2} class:danger={de >= 6}>{de.toFixed(2)}</strong>
    </div>
    <div class="small muted">ΔE 仅量化本次转换的数值差异；不代表人眼或实物打样差异。</div>
  </div>
{/snippet}

<style>
  .samplebox {
    border: 1px dashed var(--line);
    border-radius: 8px;
    padding: 8px 10px;
    min-height: 48px;
  }
  .pinbox {
    border-top: 1px solid var(--line);
    padding-top: 6px;
  }
  .divider {
    border-top: 1px solid var(--line);
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    text-align: left;
    vertical-align: top;
    padding: 4px 6px;
    border-bottom: 1px solid #ffffff0d;
  }
  th {
    font-size: 11px;
    color: var(--muted);
    font-weight: 500;
  }
  .chip {
    display: inline-block;
    margin: 0 5px 2px 0;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 0 6px;
  }
  .swatch {
    margin-top: 3px;
    display: inline-block;
    color: #fff;
    text-shadow: 0 1px 2px #000;
    padding: 1px 8px;
    border-radius: 4px;
    border: 1px solid #00000066;
  }
  .de strong {
    font-size: 16px;
  }
</style>
