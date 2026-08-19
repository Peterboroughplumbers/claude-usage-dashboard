# Claude Usage Dashboard

A small Windows desktop widget that shows the usage of up to three separate
Claude.ai accounts side by side, with a "Recommended Account" indicator.

- Electron + TypeScript + Playwright (playwright-core), no framework, minimal dependencies
- One **isolated, persistent browser profile per account** stored inside the app's
  `userData` folder (`%APPDATA%\Claude Usage Dashboard\profiles\account-N`)
- You log in **manually** in a real browser window. The app never asks for,
  sees, or stores your password. It never reads or exports cookies.
- No Anthropic API key is used; usage is read from `https://claude.ai/settings/usage`
  exactly as displayed. Nothing is fabricated — if it can't be read you see
  **Login Required** or **Unable to Read**.

## Requirements

- Windows 10/11
- Microsoft Edge or Google Chrome installed (used via Playwright; Edge ships with Windows)
- Node.js 20+ for development

## Development

```bash
npm install
npm run dev          # compile + start Electron (NODE_ENV=development)
npm run typecheck
npm run lint
npm test
npm run build        # production build -> release/Claude Usage Dashboard-Setup-<version>.exe
```

## How it works

1. Click **Login** on an account card. A browser window opens
   `claude.ai/login` in that account's private profile. Sign in however you like
   (email code/link, Google, …).
   - **Tip:** the session must end up in *that* window (the app's own profile),
     not in your everyday Chrome. If you use the e-mail login and the link from
     the e-mail opens in another browser, copy that link and paste it into the
     **"Paste it here"** box on the account card (or into the address bar of the
     app's browser window) — it is then opened inside the account's profile.
     Even simpler: while a login window is open the app watches the clipboard —
     just **copy** the login link from the e-mail and it is opened in that
     account's window automatically (only `https://claude.ai` login links are
     looked at; nothing else on the clipboard is read or stored).
     Typing the e-mail code directly into the app's window also works.
   - Google sign-in may refuse a fresh automated profile; the e-mail login is the
     most reliable option.
2. Once you are signed in, the app opens `/settings/usage` in a background tab,
   reads the numbers, and closes the window.
   While a browser window for an account is open the card shows **BROWSER OPEN**
   / **LOGGING IN…** with a **Show window** button; Login/Refresh are not
   available for that account until the window is closed.
3. Every N minutes (default 5, configurable) each account is refreshed
   headlessly using its saved session. Click **Refresh** to do it now.
4. **Open Claude** opens `claude.ai` in that account's profile. While a window
   for an account is open, background refresh for that account is paused.

The window height adjusts itself to the number of accounts (never taller than the screen). Each account is shown as a car-cluster style speedometer (needle + red-line zone) with LED-segment bars for session / weekly / model usage.

Status rules: 0–49 % Available · 50–79 % Medium · 80–94 % High · 95–100 % Near Limit.
The status uses the *highest* of the account's known percentages (session,
weekly, Sonnet weekly). The recommended account is the readable account with
the lowest effective usage.

## Claude Code (terminal) per account

Each card has a **`>_ Terminal`** button (shown when the `claude` CLI is installed).
It opens a terminal running Claude Code **signed in as that account**, using a
separate Claude Code config directory per account
(`%USERPROFILE%\.claude-accountsccount-N`, passed via `CLAUDE_CONFIG_DIR`), so all
three accounts can be used side by side without logging in/out.

- First time per account: the app runs `claude auth login`, opens the OAuth page in
  that account's own browser profile (already signed in to claude.ai) and hands the
  authorization code back to the CLI automatically — you only click **Authorize**.
- Launchers `claude1.cmd`, `claude2.cmd`, `claude3.cmd` are also written to
  `%USERPROFILE%\.localin` (if it exists) so you can type `claude2` in any terminal.
- The green *Recommended* panel has the same button for the account with the most
  capacity left.
- The per-account config dir is seeded with your global `~/.claude/settings.json`
  once; credentials are never read or copied by the app.

### Auto-switch when the usage limit is hit (Windows)

Terminals opened here don't stop when an account runs out. On Windows the launcher
runs Claude Code through a small wrapper (`claude-auto.ps1`). When the current
account hits its **session or weekly usage limit**, the wrapper:

1. notices the limit (Claude Code writes a `rate_limit` error into the session
   transcript, and the interactive limit dialog is also read from the screen),
2. stops the CLI and **moves the running session to another signed-in account**
   that still has capacity, then
3. resumes the *same conversation* there with `claude --resume <id>` — no login,
   no re-typing. You just see a one-line "continuing as <account>…" banner and the
   work goes on.

The target account is chosen from the same numbers shown on the dashboard: the
**Recommended** account first, otherwise the signed-in account with the lowest
usage. Accounts that are themselves out of capacity (or not signed in to Claude
Code) are skipped; if none is left, the session simply stays where it is. If the
limit is hit on the very first message (nothing saved yet) the wrapper starts the
request fresh on the next account instead of resuming.

- Turn it off in **Settings → Claude Code → "Auto-switch account when the usage
  limit is hit"** (or set `CLAUDE_AUTO_SWITCH=0` for one terminal). With it off,
  or for `claude` sub-commands like `auth` / `mcp` / `--continue` / `--resume`,
  the launcher is a plain pass-through.
- **Which account it moves to** — Settings → Claude Code → *"When switching,
  prefer…"*:
  - **the account with the most usage left** (default) — safest, least likely to
    run out again;
  - **the account that resets soonest** — uses up capacity that is about to reset
    anyway, keeping fresher accounts for later (your "don't waste soon-to-reset
    capacity" case).
- **Auto-switch for plain `claude` everywhere** — Settings → Claude Code →
  *"Also auto-switch for plain `claude` everywhere"*. This adds a small `claude`
  function to your PowerShell profile (a "shim") so that typing `claude` in **any**
  terminal starts on the recommended account and auto-switches on limits — not just
  terminals opened from the app. Note: with it on, plain `claude` uses these
  dashboard accounts (not your separate `~/.claude` login). Open a new terminal
  after toggling. It writes a clearly-marked block you can delete by hand, or turn
  the setting back off.
- How it works internally: the dashboard keeps `~/.claude-accounts/accounts.json`
  in sync with what it shows (percentages, recommendation, Claude Code sign-in
  state per account) and the wrapper reads it to pick the target. **No credentials
  or tokens are ever written there** — only your conversation transcript is copied
  between the per-account config dirs, which is what `--resume` needs.
- A short log of any switches is kept at `~/.claude-accounts/auto-switch.log`.

## Settings

Rename accounts · refresh interval · launch at Windows startup · **auto-hide at the right screen edge** (widget stays hidden and slides in when the mouse touches the right edge; leaves again ~0.7 s after the mouse moves away; the tray icon always shows it) · always on
top · minimize to tray · show browser during refresh (debug).

## Project structure

```
src/shared/types.ts            shared types, IPC channel names, defaults
src/shared/status.ts           status rules, recommendation, time formatting (pure, tested)
src/main/index.ts              Electron lifecycle, window, tray, IPC
src/main/accounts.ts           refresh/login orchestration, auto-refresh timer
src/main/browser.ts            per-account persistent Playwright contexts, browser detection
src/main/usage/extractor.ts    ALL claude.ai selectors/parsing (update here if the UI changes)
src/main/store.ts              settings + last snapshots (JSON in userData)
src/main/autoswitch.ts         accounts.json writer + wrapper installer (terminal auto-switch)
src/main/scripts/claude-auto.ps1  Windows wrapper: detects the limit and moves the session on
src/main/scripts/claude-shim.ps1  installs/removes the global `claude` PowerShell shim
src/main/logger.ts             redacting file logger
src/preload/index.ts           contextBridge API
src/renderer/                  widget UI (HTML/CSS/TS, no framework)
tests/                         vitest unit tests
```

## If Claude changes its usage page

Only `src/main/usage/extractor.ts` needs updating. It contains the URL, DOM
selectors and text patterns, plus a pure `parseUsage()` function that is unit
tested with sample page text in `tests/extractor.test.ts`.

## Privacy / security notes

- Sessions live only in the local Chromium profile folders under `userData`.
- Logs (`userData/logs/app.log`) go through a redaction filter and never contain
  cookies or tokens; only percentages and error kinds are logged.
- Renderer runs sandboxed with context isolation and a strict CSP; the widget
  cannot navigate or open windows.
- Google sign-in may refuse automated browsers; use the email (magic link) login
  in that case.

## Debug helpers

```bash
node scripts/dump-usage-page.mjs 2 out.txt   # dump the raw usage page text/bars for profile 2
node scripts/live-check.mjs 2                # run the compiled extractor against profile 2 (npm run compile first)
```

Both only work while the app is not using that profile (close the app or wait
for a refresh to finish). They print page text only — never cookies.
