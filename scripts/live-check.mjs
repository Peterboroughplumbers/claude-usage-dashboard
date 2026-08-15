// Runs the compiled extractor against a real profile (headless) and prints the parsed result (email masked).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { extractUsage } = require('../dist/main/usage/extractor.js');
const { join } = require('node:path');
const id = process.argv[2] ?? '2';
const profile = join(process.env.APPDATA, 'Claude Usage Dashboard', 'profiles', `account-${id}`);
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, chromiumSandbox: true, userAgent: ua,
  ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled'] });
const t0 = Date.now();
try {
  const r = await extractUsage(ctx.pages()[0] ?? (await ctx.newPage()), { includeIdentity: true });
  if (r.ok) r.usage.email = r.usage.email ? r.usage.email.replace(/^(.).*(@.*)$/, '$1***$2') : null;
  console.log(JSON.stringify(r, null, 2), `\n(${Date.now() - t0} ms)`);
} finally { await ctx.close(); }
