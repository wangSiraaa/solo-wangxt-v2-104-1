/**
 * Browser E2E for the batch proofing jobs ("批次打样作业"). Runs against the
 * Vite dev server and covers the acceptance criteria:
 *
 *  A. two images with DIFFERENT embedded profiles both complete and keep
 *     their own frozen settings snapshots (and survive a reload)
 *  B. a no-ICC image stays 待确认 and never enters the queue until the
 *     operator explicitly confirms a source profile
 *  C. the same pixel file queued under two different manual assumptions is
 *     NOT merged; an exact duplicate (same bytes + same settings) is refused
 *  D. reload during conversion: only non-terminal entries resume, finished
 *     outputs are not regenerated (attempt counts prove it)
 *  E. a failed entry retried produces a NEW attempt record without erasing
 *     the original failure or the other entry's success
 *  F. batch manifest export links every output to its own settings record
 *  G. a file carrying the conversion marker is refused as a new original
 *
 * Run: npm run dev -- --port 5199 --strictPort
 *      E2E_URL=http://localhost:5199 npm run test:e2e:batch
 */
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FIX = resolve(ROOT, 'test-assets/browser');
const OUT = resolve(ROOT, 'test-out/batch');
const URL = process.env.E2E_URL || 'http://localhost:5199';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name} ${detail}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freshPage(browser: Browser, opts: { convertDelayMs?: number } = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  if (opts.convertDelayMs) {
    await ctx.addInitScript((ms) => {
      (window as unknown as Record<string, unknown>).__SOFTPROOF_BATCH_DELAY_MS = ms;
    }, opts.convertDelayMs);
  }
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForSelector('.sidebar', { timeout: 20000 });
  (page as unknown as { __errs: string[] }).__errs = errors;
  return page;
}

async function openBatchTab(page: Page) {
  await page.getByRole('button', { name: '批次打样作业' }).click();
  await page.waitForSelector('.batch-columns', { timeout: 10000 });
}

async function newBatch(page: Page, name: string) {
  await page.locator('input[placeholder*="新批次名称"]').fill(name);
  await page.getByRole('button', { name: '新建批次' }).click();
  await page.waitForSelector('.batch-main .spread-row', { timeout: 5000 });
}

async function addFiles(page: Page, files: string[]) {
  await page.locator('.batch-main input[type=file]').setInputFiles(files);
}

const row = (page: Page, fileName: string) => page.locator('.batch-item', { hasText: fileName });

async function waitStatus(page: Page, fileName: string, st: string, timeout = 45000) {
  await row(page, fileName)
    .locator(`.badge.st-${st}`)
    .first()
    .waitFor({ state: 'visible', timeout });
}

async function attemptsCount(page: Page, fileName: string): Promise<number> {
  const summary = await row(page, fileName).locator('.attempts summary').innerText();
  const m = summary.match(/（(\d+)）/);
  return m ? Number(m[1]) : -1;
}

/** Full attempts text incl. the collapsed <details> body. */
async function attemptsText(page: Page, fileName: string): Promise<string> {
  return row(page, fileName)
    .locator('.attempts')
    .evaluate((el) => el.textContent ?? '');
}

async function confirmSource(page: Page, fileName: string, profileId: string) {
  await row(page, fileName).locator('select.confirm-select').selectOption(profileId);
  await row(page, fileName).getByRole('button', { name: '确认源配置并入队' }).click();
}

interface ItemSnapshot {
  status: string;
  settingsKey: string;
  resultAttemptId: string | null;
  resultSettingsKey: string | null;
  attempts: { id: string; outcome: string | null }[];
}

/** Read the persisted entry straight from IndexedDB (data-layer truth). */
async function readItem(page: Page, fileName: string): Promise<ItemSnapshot | null> {
  return page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('softproof-bench', 2);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const items = await new Promise<Record<string, unknown>[]>((res, rej) => {
      const t = db.transaction('batchItems', 'readonly');
      const q = t.objectStore('batchItems').getAll();
      q.onsuccess = () => res(q.result as Record<string, unknown>[]);
      q.onerror = () => rej(q.error);
    });
    db.close();
    const it = items.find((x) => x.name === name) as
      | {
          status: string;
          settingsKey: string;
          result?: { attemptId: string; settingsKey: string } | null;
          attempts: { id: string; outcome?: string }[];
        }
      | undefined;
    if (!it) return null;
    return {
      status: it.status,
      settingsKey: it.settingsKey,
      resultAttemptId: it.result?.attemptId ?? null,
      resultSettingsKey: it.result?.settingsKey ?? null,
      attempts: it.attempts.map((a) => ({ id: a.id, outcome: a.outcome ?? null })),
    };
  }, fileName);
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  // ---------- A. two embedded-profile images complete with own snapshots ----------
  {
    const page = await freshPage(browser);
    console.log('# A. two images with different embedded profiles');
    await openBatchTab(page);
    await newBatch(page, '验收A');
    await addFiles(page, [resolve(FIX, 'patches-srgb.png'), resolve(FIX, 'patches-ciergb.png')]);
    await waitStatus(page, 'patches-srgb.png', 'succeeded');
    await waitStatus(page, 'patches-ciergb.png', 'succeeded');
    ok('both items succeeded', true);

    const srcA = await row(page, 'patches-srgb.png').locator('.src-basis').innerText();
    const srcB = await row(page, 'patches-ciergb.png').locator('.src-basis').innerText();
    ok('item A source = embedded sRGB', srcA.includes('嵌入 ICC') && srcA.includes('sRGB-elle-V2-srgbtrc'), srcA);
    ok('item B source = embedded CIE RGB', srcB.includes('嵌入 ICC') && srcB.includes('CIERGB-elle-V2-g22'), srcB);
    ok('snapshots differ per item', srcA !== srcB);
    const resA = await row(page, 'patches-srgb.png').locator('.result-info').innerText();
    ok('result info shown (RGB 12×8)', resA.includes('RGB') && resA.includes('12×8'), resA);

    // persistence: reload -> same statuses & snapshots, results kept
    await page.reload();
    await page.waitForSelector('.sidebar', { timeout: 20000 });
    await openBatchTab(page);
    await waitStatus(page, 'patches-srgb.png', 'succeeded');
    await waitStatus(page, 'patches-ciergb.png', 'succeeded');
    ok('statuses survive reload', true);
    ok('attempt counts stay 1 after reload (no regeneration)', (await attemptsCount(page, 'patches-srgb.png')) === 1);
    const srcA2 = await row(page, 'patches-srgb.png').locator('.src-basis').innerText();
    ok('frozen snapshot survives reload', srcA2.includes('sRGB-elle-V2-srgbtrc'), srcA2);
    await page.close();
  }

  // ---------- B. no-ICC image waits at 待确认 until confirmed ----------
  {
    const page = await freshPage(browser);
    console.log('# B. no-ICC image stays pending-confirm, not queued');
    await openBatchTab(page);
    await newBatch(page, '验收B');
    await addFiles(page, [resolve(FIX, 'patches-noicc.png')]);
    await waitStatus(page, 'patches-noicc.png', 'pending-confirm');
    await sleep(2500); // give the queue a chance to (wrongly) pick it up
    const badges = await row(page, 'patches-noicc.png').locator('.badge').allInnerTexts();
    ok(
      'still 待确认 after wait, never queued/converting',
      badges.includes('待确认') && !badges.includes('排队中') && !badges.includes('转换中'),
      badges.join(','),
    );
    const basis = await row(page, 'patches-noicc.png').locator('.src-basis').innerText();
    ok('row explains source confirmation is required', basis.includes('缺少嵌入 ICC'), basis);

    await confirmSource(page, 'patches-noicc.png', 'builtin-srgb-elle');
    await waitStatus(page, 'patches-noicc.png', 'succeeded');
    const basis2 = await row(page, 'patches-noicc.png').locator('.src-basis').innerText();
    ok('assumption recorded as source basis', basis2.includes('人工假设') && basis2.includes('sRGB'), basis2);
    await page.close();
  }

  // ---------- C. same pixels, different assumptions -> not merged ----------
  {
    const page = await freshPage(browser);
    console.log('# C. same pixel file under different assumptions');
    await openBatchTab(page);
    await newBatch(page, '验收C');
    await addFiles(page, [resolve(FIX, 'patches-noicc.png')]);
    await waitStatus(page, 'patches-noicc.png', 'pending-confirm');
    await confirmSource(page, 'patches-noicc.png', 'builtin-srgb-elle');
    await waitStatus(page, 'patches-noicc.png', 'succeeded');

    // same file again -> a second, independent entry
    await addFiles(page, [resolve(FIX, 'patches-noicc.png')]);
    await page.waitForFunction(() => document.querySelectorAll('.batch-item').length === 2, null, { timeout: 5000 });
    ok('second entry created for same bytes', true);
    const pending2 = page.locator('.batch-item[data-status="pending-confirm"]');
    await pending2.locator('select.confirm-select').selectOption('builtin-ciergb-elle');
    await pending2.getByRole('button', { name: '确认源配置并入队' }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.batch-item[data-status="succeeded"]').length === 2,
      null,
      { timeout: 45000 },
    );
    ok('both assumptions completed as separate entries', true);
    const bases = await page.locator('.batch-item .src-basis').allInnerTexts();
    ok(
      'one assumed sRGB, one assumed CIE RGB',
      bases.some((b) => b.includes('sRGB-elle-V2-srgbtrc')) && bases.some((b) => b.includes('CIERGB-elle-V2-g22')),
      bases.join(' | '),
    );

    // exact duplicate (same bytes + same settings) must be refused
    await addFiles(page, [resolve(FIX, 'patches-noicc.png')]);
    await page.waitForFunction(() => document.querySelectorAll('.batch-item').length === 3, null, { timeout: 5000 });
    const pending3 = page.locator('.batch-item[data-status="pending-confirm"]');
    await pending3.locator('select.confirm-select').selectOption('builtin-srgb-elle');
    await pending3.getByRole('button', { name: '确认源配置并入队' }).click();
    await page.waitForFunction(
      () => document.querySelector('.batch-notice')?.textContent?.includes('完全相同'),
      null,
      { timeout: 5000 },
    );
    const notice = await page.locator('.batch-notice').innerText();
    ok('exact duplicate refused with notice', notice.includes('完全相同'), notice);
    const succeededCount = await page.locator('.batch-item[data-status="succeeded"]').count();
    ok('still exactly 2 queued/succeeded entries (no silent merge, no dup run)', succeededCount === 2, String(succeededCount));
    await page.close();
  }

  // ---------- D. reload during conversion resumes only unfinished entries ----------
  {
    const page = await freshPage(browser, { convertDelayMs: 1500 });
    console.log('# D. reload mid-conversion');
    await openBatchTab(page);
    await newBatch(page, '验收D');
    await addFiles(page, [resolve(FIX, 'patches-srgb.png'), resolve(FIX, 'patches-ciergb.png')]);
    await waitStatus(page, 'patches-srgb.png', 'succeeded', 60000);
    await waitStatus(page, 'patches-ciergb.png', 'converting', 30000);
    // item1 done, item2 in flight -> reload now
    await page.reload();
    await page.waitForSelector('.sidebar', { timeout: 20000 });
    await openBatchTab(page);
    await waitStatus(page, 'patches-srgb.png', 'succeeded', 60000);
    await waitStatus(page, 'patches-ciergb.png', 'succeeded', 60000);
    ok('both entries terminal after reload+resume', true);
    const a1 = await attemptsCount(page, 'patches-srgb.png');
    const a2 = await attemptsCount(page, 'patches-ciergb.png');
    ok('finished entry NOT regenerated (1 attempt)', a1 === 1, String(a1));
    ok('interrupted entry resumed as a new attempt (2 attempts)', a2 === 2, String(a2));
    const attemptsD = await attemptsText(page, 'patches-ciergb.png');
    ok('interrupted attempt recorded', attemptsD.includes('中断'), attemptsD.slice(0, 200));
    await page.close();
  }

  // ---------- E. failure -> retry keeps history and other results ----------
  {
    const page = await freshPage(browser);
    console.log('# E. failed entry retry creates a new attempt');
    await openBatchTab(page);
    await newBatch(page, '验收E');
    await addFiles(page, [resolve(FIX, 'broken-icc.png'), resolve(FIX, 'patches-srgb.png')]);
    await waitStatus(page, 'broken-icc.png', 'failed');
    await waitStatus(page, 'patches-srgb.png', 'succeeded');
    const err1 = await row(page, 'broken-icc.png').locator('.error-info').innerText();
    ok('failure reason shown', err1.includes('失败原因') && err1.length > 6, err1);
    ok('one attempt recorded', (await attemptsCount(page, 'broken-icc.png')) === 1);

    await row(page, 'broken-icc.png').getByRole('button', { name: '重试' }).click();
    await waitStatus(page, 'broken-icc.png', 'failed');
    await page.waitForFunction(
      () => {
        const el = [...document.querySelectorAll('.batch-item')].find((x) => x.textContent?.includes('broken-icc.png'));
        return el?.querySelector('.attempts summary')?.textContent?.includes('（2）');
      },
      null,
      { timeout: 30000 },
    );
    ok('retry produced a second attempt record', (await attemptsCount(page, 'broken-icc.png')) === 2);
    const attemptsE = await attemptsText(page, 'broken-icc.png');
    ok('original failure attempt kept', (attemptsE.match(/失败/g) ?? []).length >= 2, attemptsE.slice(0, 300));
    ok(
      'other entry still succeeded with result',
      (await row(page, 'patches-srgb.png').locator('.result-info').count()) === 1 &&
        (await attemptsCount(page, 'patches-srgb.png')) === 1,
    );
    await page.close();
  }

  // ---------- F. batch manifest links outputs to settings records ----------
  {
    const page = await freshPage(browser);
    console.log('# F. batch manifest export');
    await openBatchTab(page);
    await newBatch(page, '验收F');
    await addFiles(page, [resolve(FIX, 'patches-srgb.png'), resolve(FIX, 'patches-ciergb.png')]);
    await waitStatus(page, 'patches-srgb.png', 'succeeded');
    await waitStatus(page, 'patches-ciergb.png', 'succeeded');

    const downloads: string[] = [];
    page.on('download', (d) => {
      const p = resolve(OUT, d.suggestedFilename());
      void d.saveAs(p).then(() => downloads.push(p));
    });
    await page.getByRole('button', { name: '导出批次清单' }).click();
    for (let i = 0; i < 80 && downloads.length < 5; i++) await sleep(250);
    ok('5 files exported (2 images + 2 records + manifest)', downloads.length === 5, String(downloads.length));

    const manifestPath = downloads.find((p) => p.endsWith('.batch-manifest.json'));
    ok('manifest file present', !!manifestPath && existsSync(manifestPath!));
    if (manifestPath) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      ok('manifest format tag', manifest.manifestFormat === 'softproof-bench-batch/1', manifest.manifestFormat);
      ok('manifest has 2 entries', manifest.entries.length === 2, String(manifest.entries.length));
      const names = downloads.map((p) => p.split('/').pop());
      const allLinked = manifest.entries.every(
        (e: { status: string; output?: { fileName: string; settingsRecordFile: string } }) =>
          e.status === 'succeeded' &&
          e.output &&
          names.includes(e.output.fileName) &&
          names.includes(e.output.settingsRecordFile),
      );
      ok('every entry links output <-> settings record file', allLinked, JSON.stringify(manifest.entries.map((e: { output: unknown }) => e.output)));
      ok(
        'entries carry attempts + image hash',
        manifest.entries.every((e: { attempts: unknown[]; imageHash: string }) => e.attempts.length >= 1 && e.imageHash.length === 16),
      );
      // the two per-item settings records keep their own source snapshots
      const recordFiles = manifest.entries.map((e: { output: { settingsRecordFile: string } }) =>
        resolve(OUT, e.output.settingsRecordFile),
      );
      const records = recordFiles.map((p: string) => JSON.parse(readFileSync(p, 'utf8')));
      const srcDescs = records.map((r: { source: { description: string } }) => r.source.description);
      ok(
        'per-item records keep distinct embedded sources',
        srcDescs.some((d: string) => d.includes('sRGB-elle-V2-srgbtrc')) &&
          srcDescs.some((d: string) => d.includes('CIERGB-elle-V2-g22')),
        srcDescs.join(' | '),
      );
      ok(
        'records carry transform + provenance-ready export info',
        records.every(
          (r: { recordFormat: string; transform: { intent: string }; export: { fileName: string }; target: { id: string } }) =>
            r.recordFormat === 'softproof-bench-settings/1' &&
            r.transform.intent === 'relative-colorimetric' &&
            r.export.fileName.length > 0 &&
            r.target.id === 'builtin-ciergb-elle',
        ),
      );
    }

    // ---------- G. converted export refused as a new original ----------
    console.log('# G. converted file refused as new original');
    const proofPng = downloads.find((p) => p.endsWith('.png'));
    ok('have a converted output to re-import', !!proofPng);
    if (proofPng) {
      const before = await page.locator('.batch-item').count();
      await addFiles(page, [proofPng]);
      await page.waitForSelector('.batch-notice', { timeout: 5000 });
      const notice = await page.locator('.batch-notice').innerText();
      ok('refusal notice mentions conversion marker', notice.includes('转换标记'), notice);
      await sleep(500);
      const after = await page.locator('.batch-item').count();
      ok('no new entry created from converted file', after === before, `${before} -> ${after}`);
    }
    const errs = (page as unknown as { __errs: string[] }).__errs.filter(
      (e) => !e.includes('Failed to load resource') && !e.includes('favicon'),
    );
    ok('no page errors', errs.length === 0, errs.join(' | ').slice(0, 400));
    await page.close();
  }

  // ---------- H. cancel + reconfigure: late results never overwrite ----------
  {
    const page = await freshPage(browser, { convertDelayMs: 1500 });
    console.log('# H. late worker result vs cancelled / re-configured entry');
    await openBatchTab(page);
    await newBatch(page, '验收H');
    await addFiles(page, [resolve(FIX, 'patches-srgb.png')]);
    await waitStatus(page, 'patches-srgb.png', 'converting', 30000);
    await row(page, 'patches-srgb.png').getByRole('button', { name: '取消' }).click();
    await waitStatus(page, 'patches-srgb.png', 'cancelled');
    // The worker had already computed the result; it arrives "late" now.
    await sleep(3000);
    const afterCancel = await readItem(page, 'patches-srgb.png');
    ok(
      'cancelled entry not overwritten by late result',
      afterCancel?.status === 'cancelled' && afterCancel.resultAttemptId === null,
      JSON.stringify(afterCancel),
    );
    ok('cancelled attempt recorded', afterCancel?.attempts[0]?.outcome === 'cancelled');

    // Re-configure (flip BPC) and requeue; the stale task must stay inert.
    await row(page, 'patches-srgb.png').getByRole('button', { name: '重新配置' }).click();
    await row(page, 'patches-srgb.png').locator('.editgrid input[type=checkbox]').uncheck();
    await row(page, 'patches-srgb.png').getByRole('button', { name: '应用并重新排队' }).click();
    await waitStatus(page, 'patches-srgb.png', 'succeeded', 60000);
    const final = await readItem(page, 'patches-srgb.png');
    ok('reconfigured entry has 2 attempts', final?.attempts.length === 2, JSON.stringify(final?.attempts));
    ok(
      'success belongs to the new attempt, not the late one',
      !!final && final.resultAttemptId === final.attempts[final.attempts.length - 1].id,
      JSON.stringify(final),
    );
    ok(
      'result matches the changed settings signature',
      !!final && final.resultSettingsKey === final.settingsKey && final.settingsKey.includes('bpc0'),
      final?.settingsKey,
    );
    const snap = await row(page, 'patches-srgb.png').locator('.settings-snap').innerText();
    ok('snapshot shows updated BPC=off', snap.includes('BPC 关'), snap);
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
