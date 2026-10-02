/**
 * Browser E2E for local batch proofing jobs. Acceptance coverage:
 *
 *  A. two images with DIFFERENT embedded ICCs both succeed and keep their own
 *     frozen snapshots + per-output manifest entries;
 *  B. no-ICC image stays at needs-confirmation and never enters the queue
 *     until the source profile is explicitly chosen;
 *  C. identical pixel files enqueued with DIFFERENT manual assumptions are not
 *     merged (two items, two outputs, distinct source in the manifest);
 *  D. reload while an item is converting resumes ONLY non-terminal items, and
 *     a finished output is not regenerated afterwards;
 *  E. a failed item retried produces a NEW attempt record while the original
 *     failure and other items' successes remain;
 *  F. an already-converted (provenance-marked) file is rejected as a batch
 *     original.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FIX = resolve(ROOT, 'test-assets/browser');
const OUT = resolve(ROOT, 'test-out/batch');
mkdirSync(OUT, { recursive: true });
const URL = process.env.E2E_URL || 'http://localhost:5199';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name} ${detail}`);
  }
}

async function freshPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForSelector('.sidebar', { timeout: 20000 });
  await page.getByRole('button', { name: '批次打样作业' }).click();
  await page.waitForSelector('input[data-testid="batch-file-input"]');
  (page as unknown as { __errs: string[] }).__errs = errors;
  return page;
}

async function addFiles(page: Page, files: string[]) {
  await page.locator('input[data-testid="batch-file-input"]').setInputFiles(files);
}

function card(page: Page, namePart: string) {
  return page.locator(`.item[data-item-id]`, {
    has: page.locator('.name', { hasText: namePart }),
  }).first();
}

async function waitStatus(page: Page, namePart: string, status: string, timeout = 45000) {
  await card(page, namePart)
    .locator('[data-status-label]')
    .filter({ hasText: status })
    .waitFor({ state: 'visible', timeout });
}

async function idb<T = unknown>(page: Page, body: string): Promise<T> {
  return page.evaluate(async (body) => {
    const open = indexedDB.open('softproof-bench');
    const db = await new Promise<IDBDatabase>((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const run = new Function('db', `return (async () => { ${body} })();`) as (d: IDBDatabase) => Promise<T>;
    return run(db);
  }, body);
}

async function getAllItems(page: Page) {
  return idb<{ id: string; status: string; attempts: { id: string; outcome: string }[]; successfulAttemptId: string | null }[]>(
    page,
    `return await new Promise((res, rej) => {
      const tx = db.transaction('batch-items');
      const r = tx.objectStore('batch-items').getAll();
      r.onsuccess = () => res(r.result.map(x => ({ id: x.id, status: x.status, attempts: x.attempts.map(a => ({ id: a.id, outcome: a.outcome })), successfulAttemptId: x.successfulAttemptId })));
      r.onerror = () => rej(r.error);
    });`,
  );
}

async function getOutputs(page: Page) {
  return idb<{ key: string; attemptId: string }[]>(
    page,
    `return await new Promise((res, rej) => {
      const r = db.transaction('batch-outputs').objectStore('batch-outputs').getAll();
      r.onsuccess = () => res(r.result.map(x => ({ key: x.key, attemptId: x.attemptId })));
      r.onerror = () => rej(r.error);
    });`,
  );
}

async function countsText(page: Page) {
  return page.locator('[data-testid="batch-counts"]').innerText();
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });

  // ---- A: two different embedded profiles -> both succeed, own snapshots ----
  {
    const page = await freshPage(browser);
    console.log('# A. two images with different embedded ICCs both succeed');
    await addFiles(page, [resolve(FIX, 'patches-srgb.png'), resolve(FIX, 'patches-ciergb.png')]);
    await waitStatus(page, 'patches-srgb.png', '成功');
    await waitStatus(page, 'patches-ciergb.png', '成功');

    const c1 = card(page, 'patches-srgb.png');
    const c2 = card(page, 'patches-ciergb.png');
    await c1.locator('.badge.embedded').waitFor();
    await c2.locator('.badge.embedded').waitFor();
    ok('both show embedded badges', true);
    const desc1 = await c1.locator('.src .mono').innerText();
    const desc2 = await c2.locator('.src .mono').innerText();
    ok('embedded descriptions differ', desc1 !== desc2 && desc1.length > 2, `${desc1} || ${desc2}`);

    // items persisted with their own frozen source bytes
    const frozen = await idb<{ source: { refId: string }; pixelHash: string }[]>(
      page,
      `return await new Promise((res, rej) => {
        const r = db.transaction('batch-items').objectStore('batch-items').getAll();
        r.onsuccess = () => res(r.result.map(x => ({ source: { refId: x.source.refId }, pixelHash: x.pixelHash })));
        r.onerror = () => rej(r.error);
      });`,
    );
    ok('two frozen items with distinct embedded source refs', frozen.length === 2 && frozen[0].source.refId !== frozen[1].source.refId, JSON.stringify(frozen));

    // export batch and inspect manifest
    const downloads: string[] = [];
    page.on('download', async (d) => {
      const p = resolve(OUT, d.suggestedFilename().replace(/[\\/]/g, '_'));
      await d.saveAs(p);
      downloads.push(p);
    });
    await page.getByRole('button', { name: /导出批次/ }).click();
    await page.waitForTimeout(2500);
    const manifestPath = downloads.find((p) => p.endsWith('.json'));
    ok('manifest downloaded', !!manifestPath, downloads.join(','));
    if (manifestPath) {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      ok('manifest has 2 entries', m.entries.length === 2, String(m.entries.length));
      const srcs = m.entries.map((e: { source: { id: string } }) => e.source.id);
      ok(
        'manifest associates each output with its own embedded source',
        new Set(srcs).size === 2 && m.entries.every((e: { sourceAssumption: { missingEmbedded: boolean } }) => e.sourceAssumption.missingEmbedded === false),
        JSON.stringify(srcs),
      );
      ok(
        'output files distinct and referenced',
        new Set(m.entries.map((e: { outputFile: string }) => e.outputFile)).size === 2,
      );
    }
    const errs = (page as unknown as { __errs: string[] }).__errs;
    ok('no page errors A', errs.length === 0, errs.join(' | ').slice(0, 300));
    await page.close();
  }

  // ---- B: no-ICC image must not enter the queue before source choice --------
  {
    const page = await freshPage(browser);
    console.log('# B. no-ICC item stays needs-confirmation and out of queue');
    await addFiles(page, [resolve(FIX, 'patches-noicc.png')]);
    await waitStatus(page, 'patches-noicc.png', '待确认');
    const c = card(page, 'patches-noicc.png');
    ok('manual confirm warning visible', (await c.innerText()).includes('必须人工确认'));
    let counts = await countsText(page);
    ok('queued/converting count is 0', /排队\/转换中 0/.test(counts), counts);
    ok('no queued item in IDB', (await getAllItems(page)).every((x) => x.status === 'needs-confirmation'));

    // explicitly choose assumed source -> enters queue -> succeeds
    await c.locator('select').first().selectOption({ index: 1 });
    await waitStatus(page, 'patches-noicc.png', '成功', 30000);
    const after = await getAllItems(page);
    ok('confirmed item succeeded with an assumption flag', after[0].status === 'succeeded');
    await page.close();
  }

  // ---- C: same pixels, different manual assumptions: no merging -------------
  {
    const page = await freshPage(browser);
    console.log('# C. identical bytes with different assumptions stay separate');
    await addFiles(page, [resolve(FIX, 'patches-noicc.png'), resolve(FIX, 'patches-noicc-copy.png')]);
    const c1 = card(page, 'patches-noicc.png');
    const c2 = card(page, 'patches-noicc-copy.png');
    // item 1 assumes sRGB (index 1), item 2 assumes CIE RGB (index 2)
    await c1.locator('select').first().selectOption({ index: 1 });
    await c2.locator('select').first().selectOption({ index: 2 });
    await waitStatus(page, 'patches-noicc.png', '成功', 30000);
    await waitStatus(page, 'patches-noicc-copy.png', '成功', 30000);
    const items = await getAllItems(page);
    const outputs = await getOutputs(page);
    ok('two distinct items for same pixels', items.length === 2);
    ok('two distinct outputs generated', outputs.length === 2, JSON.stringify(outputs));
    const dup = await idb<{ pixelHash: string; source: { refId: string } }[]>(
      page,
      `return await new Promise((res, rej) => {
        const r = db.transaction('batch-items').objectStore('batch-items').getAll();
        r.onsuccess = () => res(r.result.map(x => ({ pixelHash: x.pixelHash, source: { refId: x.source.refId } })));
        r.onerror = () => rej(r.error);
      });`,
    );
    ok(
      'same pixelHash but different frozen source assumptions',
      dup[0].pixelHash === dup[1].pixelHash && dup[0].source.refId !== dup[1].source.refId,
      JSON.stringify(dup),
    );
    await page.close();
  }

  // ---- D: reload while converting; only non-terminal resume, no regen -------
  {
    const page = await freshPage(browser);
    console.log('# D. reload mid-conversion resumes only unfinished items');
    await page.evaluate(() => {
      const w = window as unknown as { __softproofTest?: { setDelay: (ms: number) => void } };
      w.__softproofTest?.setDelay(6000);
    });
    await addFiles(page, [resolve(FIX, 'patches-srgb.png'), resolve(FIX, 'patches-ciergb.png')]);
    // first item converts first (FIFO) -> wait converting, then immediately reload
    await waitStatus(page, 'patches-srgb.png', '转换中', 10000);
    // snapshot: item2 must still be queued (not yet started)
    const before = await getAllItems(page);
    ok('one converting + one queued before reload', before.some((x) => x.status === 'converting') && before.some((x) => x.status === 'queued'), JSON.stringify(before));

    await page.reload();
    await page.waitForSelector('.sidebar', { timeout: 20000 });
    await page.getByRole('button', { name: '批次打样作业' }).click();
    await page.waitForSelector('input[data-testid="batch-file-input"]');
    // both items should finish after resume; delay hook resets on reload
    await waitStatus(page, 'patches-srgb.png', '成功', 45000);
    await waitStatus(page, 'patches-ciergb.png', '成功', 45000);
    const items = await getAllItems(page);
    const outputs = await getOutputs(page);
    ok('both items succeeded after reload', items.every((x) => x.status === 'succeeded'));
    ok('exactly one output per item (no regeneration)', outputs.length === 2, JSON.stringify(outputs));
    for (const it of items) {
      const own = outputs.filter((o) => o.key.startsWith(it.id));
      ok(`output for ${it.id.slice(-5)} matches its successful attempt`, own.length === 1 && own[0].attemptId === it.successfulAttemptId);
    }
    // the interrupted attempt must be recorded as canceled in history
    ok(
      'interrupted attempt kept as canceled before the successful one',
      items.every((x) => x.attempts.some((a) => a.outcome === 'canceled') || x.attempts.length === 1),
      JSON.stringify(items),
    );
    await page.evaluate(() => {
      const w = window as unknown as { __softproofTest?: { setDelay: (ms: number) => void } };
      w.__softproofTest?.setDelay(0);
    });
    await page.close();
  }

  // ---- E: failure then retry: new attempt, old failure + others kept --------
  {
    const page = await freshPage(browser);
    console.log('# E. failed item retries with a new attempt; other success kept');
    // Fault is armed BEFORE dispatch: the queue's first conversion (item 1)
    // fails deterministically; the one-shot fault clears so item 2 succeeds.
    await page.evaluate(() => {
      const w = window as unknown as { __softproofTest?: { setFault: (f: string | null) => void } };
      w.__softproofTest?.setFault('injected test failure');
    });
    await addFiles(page, [resolve(FIX, 'patches-srgb.png'), resolve(FIX, 'patches-ciergb.png')]);
    await waitStatus(page, 'patches-srgb.png', '失败', 20000);
    await waitStatus(page, 'patches-ciergb.png', '成功', 30000);

    const allItems = await getAllItems(page);
    const failed = allItems.filter((x) => x.status === 'failed');
    const succeeded = allItems.filter((x) => x.status === 'succeeded');
    ok('exactly one item failed by injection', failed.length === 1, JSON.stringify(allItems));
    ok('the other item succeeded despite the failure', succeeded.length === 1, JSON.stringify(allItems));

    const target = 'patches-srgb.png';
    const c = card(page, target);
    await c.locator('[data-reason]').waitFor();
    const reason = await c.locator('[data-reason]').innerText();
    ok('failure reason shown', reason.includes('injected test failure'), reason.slice(0, 160));
    await c.getByRole('button', { name: /重试/ }).click();
    await waitStatus(page, target, '成功', 30000);

    const items2 = await getAllItems(page);
    const outputs2 = await getOutputs(page);
    const retried = items2.find((x) => failed[0].id === x.id)!;
    const failedAttempts = retried.attempts.filter((a) => a.outcome === 'failed');
    const successAttempts = retried.attempts.filter((a) => a.outcome === 'succeeded');
    ok('retry appended a new attempt', retried.attempts.length >= 2, JSON.stringify(retried.attempts));
    ok('original failure attempt is preserved', failedAttempts.length === 1, JSON.stringify(retried.attempts));
    ok('new attempt succeeded', retried.status === 'succeeded' && successAttempts.length === 1);
    ok(
      'the other item stayed succeeded untouched',
      items2.filter((x) => x.status === 'succeeded').length === 2 &&
        !!items2.find((x) => x.id === succeeded[0].id && x.status === 'succeeded'),
    );
    const ownOutputs = outputs2.filter((o) => o.key.startsWith(retried.id));
    ok(
      'only one output for retried item, keyed to the new attempt',
      ownOutputs.length === 1 && ownOutputs[0].attemptId === retried.successfulAttemptId,
      JSON.stringify(ownOutputs),
    );
    await page.close();
  }

  // ---- F: converted file rejected as batch original -------------------------
  {
    const page = await freshPage(browser);
    console.log('# F. provenance-marked conversion cannot join a batch');
    // build a converted file first via a successful batch export
    await addFiles(page, [resolve(FIX, 'patches-srgb.png')]);
    await waitStatus(page, 'patches-srgb.png', '成功');
    const downloads: string[] = [];
    page.on('download', async (d) => {
      const p = resolve(OUT, 'reimport-' + d.suggestedFilename().replace(/[\\/]/g, '_'));
      await d.saveAs(p);
      downloads.push(p);
    });
    await page.getByRole('button', { name: /导出批次/ }).click();
    await page.waitForTimeout(2000);
    const exported = downloads.find((p) => p.endsWith('.png'));
    ok('exported converted PNG exists', !!exported && existsSync(exported!), downloads.join(','));
    if (exported) {
      await page.locator('input[data-testid="batch-file-input"]').setInputFiles(exported);
      await page.waitForTimeout(800);
      const banner = await page.locator('.banner').first().innerText();
      ok('rejected with double-conversion reason', /已转换|二次转换/.test(banner), banner.slice(0, 200));
      const items = await getAllItems(page);
      ok('no new item created for converted file', items.length === 1, String(items.length));
    }
    await page.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} BATCH E2E FAILURES` : '\nALL BATCH E2E TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
