import { chromium } from 'playwright';

async function main() {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage();
  const errs: string[] = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(process.env.URL || 'http://localhost:5198');
  await p.waitForSelector('.sidebar', { timeout: 15000 });
  const title = await p.locator('h1').innerText();
  const profiles = await p.locator('.profilelist .pl').count();
  console.log('title:', title.trim());
  console.log('seeded profiles in library:', profiles);
  console.log('page errors:', errs.length ? errs.join(' | ') : 'none');
  await b.close();
  process.exit(errs.length ? 1 : 0);
}
main();
