<script lang="ts">
  import type { SampleInfo } from '../color/engine';

  interface Props {
    title: string;
    subtitle?: string;
    width: number;
    height: number;
    /** raw RGBA pixels to draw */
    rgba?: Uint8Array | null;
    /** CSS color-management hint for display */
    displayMode?: 'original' | 'softproof';
    pins?: { x: number; y: number }[];
    hover?: { x: number; y: number } | null;
    onmove?: (x: number, y: number) => void;
    onleave?: () => void;
    onpin?: (x: number, y: number) => void;
    accent?: string;
  }

  let {
    title,
    subtitle = '',
    width,
    height,
    rgba = null,
    displayMode = 'softproof',
    pins = [],
    hover = null,
    onmove,
    onleave,
    onpin,
    accent = '#5aa7ff',
  }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let container = $state<HTMLDivElement | null>(null);
  let scale = $state(1);

  // Draw whenever pixels or size change.
  $effect(() => {
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (rgba) {
      const buf = new Uint8ClampedArray(rgba.byteLength);
      buf.set(rgba);
      const img = new ImageData(buf, width, height);
      ctx.putImageData(img, 0, 0);
    } else {
      ctx.clearRect(0, 0, width, height);
    }
    fit();
  });

  // Fit inside container while keeping pixel aspect 1:1.
  $effect(() => {
    if (!container) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(container);
    return () => ro.disconnect();
  });

  function fit() {
    if (!container || !width || !height) return;
    const rect = container.getBoundingClientRect();
    scale = Math.min(rect.width / width, rect.height / height, 4);
    if (canvas) {
      canvas.style.width = `${Math.round(width * scale)}px`;
      canvas.style.height = `${Math.round(height * scale)}px`;
    }
  }

  function eventXY(e: MouseEvent): { x: number; y: number } {
    const rect = canvas!.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * height);
    return {
      x: Math.min(width - 1, Math.max(0, x)),
      y: Math.min(height - 1, Math.max(0, y)),
    };
  }
</script>

<div class="view stack">
  <div class="row spread">
    <div>
      <strong>{title}</strong>
      {#if subtitle}<span class="muted small"> · {subtitle}</span>{/if}
    </div>
    <span class="badge" class:embedded={displayMode === 'softproof'}>
      {displayMode === 'softproof' ? '软打样预览（目标→显示器模拟）' : '原图像素（嵌入/假设源配置）'}
    </span>
  </div>
  <div class="stage checker scroll" bind:this={container}>
    <div class="canvasWrap" style={`--accent:${accent}`}>
      <canvas
        bind:this={canvas}
        onmousemove={(e) => onmove?.(eventXY(e).x, eventXY(e).y)}
        onmouseleave={() => onleave?.()}
        onclick={(e) => onpin?.(eventXY(e).x, eventXY(e).y)}
      ></canvas>
      {#if hover}
        <div
          class="mark hover"
          style={`left:${hover.x * scale}px;top:${hover.y * scale}px`}
        ></div>
      {/if}
      {#each pins as p}
        <div class="mark pin" style={`left:${p.x * scale}px;top:${p.y * scale}px`}></div>
      {/each}
    </div>
  </div>
</div>

<style>
  .view {
    min-height: 0;
    flex: 1;
  }
  .stage {
    flex: 1;
    min-height: 240px;
    border: 1px solid var(--line);
    border-radius: 8px;
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
    padding: 8px;
  }
  .canvasWrap {
    position: relative;
    line-height: 0;
  }
  canvas {
    image-rendering: pixelated;
    border: 1px solid #00000055;
    cursor: crosshair;
  }
  .mark {
    position: absolute;
    width: 12px;
    height: 12px;
    margin-left: -6px;
    margin-top: -6px;
    border-radius: 50%;
    pointer-events: none;
  }
  .mark.hover {
    border: 1.5px solid var(--accent);
  }
  .mark.pin {
    border: 2px solid var(--accent);
    background: #00000055;
  }
</style>
