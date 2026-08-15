// Debug helper: dumps the visible text + progress bar values of claude.ai/settings/usage
// for one account profile, so the extractor patterns can be checked against the real page.
// Usage: node scripts/dump-usage-page.mjs <accountId> [outFile]
// Only page text is written — never cookies or tokens.
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';

const id = process.argv[2] ?? '1';
const out = process.argv[3] ?? `usage-page-${id}.txt`;
const profile = join(process.env.APPDATA, 'Claude Usage Dashboard', 'profiles', `account-${id}`);
const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find(existsSync);
const channel = chrome ? 'chrome' : 'msedge';

const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
const ctx = await chromium.launchPersistentContext(profile, { channel, headless: true, chromiumSandbox: true, userAgent: ua,
  args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://claude.ai/settings/usage', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
const text = await page.evaluate(() => document.body.innerText);
const bars = await page.$$eval('[role="progressbar"], progress', (els) => els.map((e) => ({ now: e.getAttribute('aria-valuenow'), max: e.getAttribute('aria-valuemax'), value: e.getAttribute('value'), cls: e.className.slice(0, 80) })));
const html = await page.evaluate(() => document.querySelector('main')?.innerHTML.slice(0, 20000) ?? '');
writeFileSync(out, `URL: ${page.url()}\nTITLE: ${await page.title()}\n\n--- TEXT ---\n${text}\n\n--- BARS ---\n${JSON.stringify(bars, null, 2)}\n\n--- MAIN HTML (truncated) ---\n${html}\n`);
await ctx.close();
console.log('written', out);
