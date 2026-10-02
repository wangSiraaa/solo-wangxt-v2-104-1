<script lang="ts">
  /**
 * Item thumbnail. Shows the soft-proof result when the item has a successful
 * output, otherwise the frozen original pixels (decoded locally). All bytes
 * come from IndexedDB; nothing is uploaded.
 */
  import { getBatch } from '../batch/batch.svelte';
  import { decodeImage } from '../codec/decode';
  import { idbGet, STORE_BATCH_ITEMS, type StoredBatchItem } from '../db/db';
  import type { BatchItemView } from '../batch/types';

  interface Props {
    jobId: string;
    itemId: string;
    size?: number;
    item?: BatchItemView | null;
  }
  let { jobId, itemId, size = 44, item = null }: Props = $props();
  const batch = getBatch();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let attemptId = $state<string | null>(null);

  // Subscribe to status/success changes of the (optional) view.
  $effect(() => {
    attemptId = item?.successfulAttemptId ?? null;
  });

  $effect(() => {
    const cvs = canvas;
    const aid = attemptId;
    if (!cvs) return;
    let cancelled = false;
    void (async () => {
      try {
        if (aid) {
          const out = await batch.getOutput(itemId, aid);
          if (cancelled || !out) return;
          await drawRgba(cvs, out.softProofRGBA, out.width, out.height, size ?? 44);
          return;
        }
        // Original preview: read the frozen record bytes lazily.
        const rec = await idbGet<StoredBatchItem>(STORE_BATCH_ITEMS, itemId);
        if (cancelled || !rec) return;
        const d = await decodeImage(rec.imageBytes);
        const rgba =
          d.channels === 4
            ? d.data
            : (() => {
                const out = new Uint8Array(d.width * d.height * 4);
                for (let i = 0; i < d.width * d.height; i++) {
                  out[i * 4] = d.data[i * d.channels];
                  out[i * 4 + 1] = d.data[i * d.channels + 1] ?? d.data[i * d.channels];
                  out[i * 4 + 2] = d.data[i * d.channels + 2] ?? d.data[i * d.channels];
                  out[i * 4 + 3] = 255;
                }
                return out;
              })();
        if (!cancelled) await drawRgba(cvs, rgba, d.width, d.height, size ?? 44);
      } catch {
        /* thumbnail best-effort */
      }
    })();
    return () => (cancelled = true);
  });

  async function drawRgba(cvs: HTMLCanvasElement, rgba: Uint8Array, w: number, h: number, outSize: number) {
    const ctx = cvs.getContext('2d')!;
    const pixels = new Uint8ClampedArray(w * h * 4);
    pixels.set(rgba.subarray(0, w * h * 4));
    const img = new ImageData(pixels, w, h);
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, outSize, outSize);
    ctx.imageSmoothingEnabled = true;
    const scale = Math.min(outSize / w, outSize / h);
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    ctx.drawImage(tmp, (outSize - dw) / 2, (outSize - dh) / 2, dw, dh);
  }
</script>

<canvas bind:this={canvas} width={size} height={size} class="checker thumb" data-thumb={itemId}></canvas>

<style>
  .thumb {
    width: 44px;
    height: 44px;
    border-radius: 6px;
    border: 1px solid var(--line);
    object-fit: contain;
  }
</style>
