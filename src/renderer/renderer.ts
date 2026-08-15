import {
  accountStatus,
  effectivePercent,
  formatAgo,
  formatRemaining,
  recommendAccount,
  statusForPercent,
  statusLabel,
} from '../shared/status.js';
import type { AccountState, DashboardApi, DashboardState, Settings, UsageErrorKind } from '../shared/types.js';

declare global {
  interface Window {
    dashboard: DashboardApi;
  }
}

const api = window.dashboard;

let state: DashboardState | null = null;
let settingsOpen = false;
/** Entrance animations only on the very first paint — later re-renders must not blink. */
let firstPaint = true;
/** Text typed into the "paste login link" boxes, kept across re-renders. */
const linkDrafts = new Map<number, string>();
/** Feedback shown under the paste box (error text or success note). */
const linkFeedback = new Map<number, { text: string; error: boolean }>();
/** Last error from "Terminal" per account (cleared on next attempt). */
const terminalErrors = new Map<number, string>();

/* ------------------------------ DOM helpers ------------------------------ */

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, className: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

/* --------------------------------- text ---------------------------------- */

const ERROR_TEXT: Record<UsageErrorKind, string> = {
  login_required: 'Login Required',
  unavailable: 'Unable to Read — Claude page unavailable',
  unreadable: 'Unable to Read — usage info not found',
  network: 'Unable to Read — network error',
  browser_busy: 'Unable to Read — browser busy',
  no_browser: 'No Edge/Chrome browser found',
};

function fmtPercent(v: number | null): string {
  return v === null ? '–' : `${Math.round(v)}%`;
}

function resetText(text: string | null, at: number | null, now: number): string | null {
  if (at !== null) return formatRemaining(at, now);
  if (!text) return null;
  return text.replace(/^resets?\s*/i, '');
}

/* -------------------------------- render --------------------------------- */

function metric(label: string, value: number | null): HTMLElement {
  const row = el('div', value === null ? 'metric' : `metric ${statusForPercent(value)}`);
  row.append(el('span', 'metric-label', label));
  const bar = el('div', 'bar');
  const fill = el('span');
  if (value !== null) {
    fill.className = statusForPercent(value);
    fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
  }
  bar.append(fill);
  row.append(bar);
  row.append(el('span', 'metric-value', fmtPercent(value)));
  return row;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_R = 17;
const RING_C = 2 * Math.PI * RING_R;

/** Small circular gauge showing the account's effective (highest) usage. */
function ringGauge(percent: number | null): HTMLElement {
  const wrap = el('div', 'ring');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('class', 'ring-track');
  track.setAttribute('cx', '20');
  track.setAttribute('cy', '20');
  track.setAttribute('r', String(RING_R));
  svg.append(track);
  const p = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const fill = document.createElementNS(SVG_NS, 'circle');
  fill.setAttribute('class', `ring-fill ${percent === null ? 'none' : statusForPercent(percent)}`);
  fill.setAttribute('cx', '20');
  fill.setAttribute('cy', '20');
  fill.setAttribute('r', String(RING_R));
  fill.setAttribute('stroke-dasharray', `${(p / 100) * RING_C} ${RING_C}`);
  svg.append(fill);
  wrap.append(svg);
  wrap.append(el('span', 'ring-value', percent === null ? '–' : `${Math.round(percent)}`));
  return wrap;
}

function renderCard(a: AccountState, recommendedId: number | null, now: number): HTMLElement {
  const card = el('article', firstPaint ? 'card enter' : 'card');
  if (a.id === recommendedId) card.classList.add('recommended-card');
  card.style.setProperty('--i', String(a.id - 1));

  const head = el('div', 'card-head');
  head.append(ringGauge(a.error === 'login_required' ? null : effectivePercent(a)));
  const names = el('div', 'card-names');
  const nameEl = el('div', 'card-name', a.name);
  names.append(nameEl);
  const sub = [a.usage?.email ?? a.usage?.displayName, a.usage?.planName].filter(Boolean).join(' · ');
  if (sub) names.append(el('div', 'card-email', sub));
  head.append(names);

  const status = accountStatus(a);
  if (a.readState === 'refreshing') {
    // Quiet background refresh: keep the last known badge, just show a small sync dot.
    nameEl.append(el('span', 'sync-dot'));
    if (a.usage && status && !a.error) head.append(el('span', `badge ${status}`, statusLabel(status)));
    else if (a.error === 'login_required') head.append(el('span', 'badge warn', 'LOGIN REQUIRED'));
    else head.append(el('span', 'badge neutral', 'READING…'));
  } else if (a.loginInProgress) head.append(el('span', 'badge neutral', 'LOGGING IN…'));
  else if (a.windowOpen) head.append(el('span', 'badge neutral', 'BROWSER OPEN'));
  else if (a.error === 'login_required') head.append(el('span', 'badge warn', 'LOGIN REQUIRED'));
  else if (a.error) head.append(el('span', 'badge warn', 'UNABLE TO READ'));
  else if (status && a.usage) head.append(el('span', `badge ${status}`, statusLabel(status)));
  else head.append(el('span', 'badge neutral', 'NO DATA'));
  card.append(head);

  const u = a.usage;
  if (a.error) {
    const msg = el('div', `card-msg${a.error === 'login_required' ? '' : ' error'}`, ERROR_TEXT[a.error]);
    if (a.errorDetail && a.error !== 'login_required') msg.title = a.errorDetail;
    card.append(msg);
  }
  if (u && a.error !== 'login_required') {
    // Real values from the last successful read; shown dimmed ("stale") when the latest attempt failed.
    const stale = a.error !== null;
    const metrics = el('div', stale ? 'metrics stale' : 'metrics');
    metrics.append(metric('Session', u.sessionPercent));
    metrics.append(metric('Weekly', u.weeklyPercent));
    if (u.modelWeeklyPercent !== null) metrics.append(metric(u.modelWeeklyLabel ?? 'Model', u.modelWeeklyPercent));
    card.append(metrics);

    const meta = el('div', 'card-meta');
    const sReset = resetText(u.sessionResetText, u.sessionResetAt, now);
    const wReset = resetText(u.weeklyResetText, u.weeklyResetAt, now);
    const parts: string[] = [];
    if (sReset) parts.push(`Reset: ${sReset}`);
    if (wReset) parts.push(`Weekly: ${wReset}`);
    meta.append(el('span', 'reset', parts.length ? parts.join(' · ') : 'Reset: –'));
    if (a.lastSuccessAt) meta.append(el('span', '', `${stale ? 'last read ' : ''}${formatAgo(a.lastSuccessAt, now)}`));
    card.append(meta);
  } else if (a.error) {
    if (a.lastSuccessAt && a.error !== 'login_required') {
      card.append(el('div', 'card-msg', `Last successful read ${formatAgo(a.lastSuccessAt, now)}`));
    }
  } else if (a.readState === 'refreshing') {
    card.append(el('div', 'card-msg', a.lastSuccessAt ? 'Refreshing…' : 'Reading usage…'));
  } else if (a.loginInProgress) {
    card.append(el('div', 'card-msg', 'Complete the login in the browser window…'));
  } else if (a.windowOpen) {
    card.append(el('div', 'card-msg', 'Claude is open in a browser window. Usage is re-read when you close it.'));
  } else {
    card.append(el('div', 'card-msg', 'Not logged in yet.'));
  }

  if (a.loginInProgress) card.append(loginLinkBox(a.id));

  const actions = el('div', 'card-actions');
  const reading = a.readState === 'refreshing' && !a.usage; // only disable while there is nothing to show
  const needsLogin = a.error === 'login_required' || !a.hasProfile;
  if (a.windowOpen) {
    // A visible browser window for this profile is open: offer to bring it to the front.
    actions.append(button('Show window', 'btn primary small', () => void api.focusWindow(a.id)));
    if (a.loginInProgress) actions.append(el('span', 'card-hint', 'Close the window to cancel'));
  } else if (needsLogin) {
    actions.append(button('Login', 'btn primary small', () => void api.login(a.id), reading));
    if (reading) actions.append(el('span', 'card-hint', 'Available after this read'));
  } else {
    actions.append(button('Open Claude', 'btn small', () => void api.openClaude(a.id), reading));
    actions.append(button('Refresh', 'btn small', () => void api.refreshOne(a.id), reading));
    actions.append(button('Re-login', 'btn small', () => void api.login(a.id), reading));
  }
  if (state?.claudeCliFound) {
    const t = a.terminal;
    const label = a.terminalBusy ? 'Setting up…' : t?.loggedIn ? '>_ Terminal' : '>_ Terminal (setup)';
    const tb = button(label, 'btn small terminal', () => void openTerminal(a.id), a.terminalBusy || a.windowOpen);
    tb.title = t?.loggedIn
      ? `Open Claude Code signed in as ${t.email ?? a.name}`
      : 'Open Claude Code as this account — first time asks you to click "Authorize" once';
    actions.append(tb);
  }
  card.append(actions);

  if (state?.claudeCliFound) {
    const t = a.terminal;
    const line = el('div', 'term-line');
    if (a.terminalBusy) {
      line.append(el('span', 'term-dot busy'), el('span', '', 'Claude Code: signing in — click Authorize in the browser window…'));
    } else if (t?.loggedIn) {
      line.append(el('span', 'term-dot ok'), el('span', '', `Claude Code: ${t.email ?? 'signed in'}${t.subscription ? ` · ${t.subscription}` : ''}`));
    } else {
      line.append(el('span', 'term-dot'), el('span', '', 'Claude Code: not set up yet'));
    }
    const err = terminalErrors.get(a.id);
    if (err) line.append(el('span', 'term-err', err));
    card.append(line);
  }
  return card;
}

async function openTerminal(id: AccountState['id']): Promise<void> {
  terminalErrors.delete(id);
  const err = await api.terminalOpen(id);
  if (err) {
    terminalErrors.set(id, err);
    render();
  }
}

/**
 * "Paste login link" box shown while a login window is open.
 * If the e-mail login link opened in another browser (i.e. the wrong profile),
 * the user can paste it here and it is opened inside the account's own login window.
 */
function loginLinkBox(id: AccountState['id']): HTMLElement {
  const box = el('div', 'link-box');
  box.append(
    el('div', 'link-hint', 'Login link opened in another browser? Paste it here to open it in this account\u2019s window:'),
  );
  const row = el('div', 'link-row');
  const input = el('input', 'link-input');
  input.type = 'url';
  input.placeholder = 'https://claude.ai/…';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.dataset['linkFor'] = String(id);
  input.value = linkDrafts.get(id) ?? '';
  const saved = linkFeedback.get(id);
  const fb = el('div', saved?.error ? 'link-feedback error' : 'link-feedback', saved?.text ?? '');
  const setFeedback = (text: string, error: boolean): void => {
    linkFeedback.set(id, { text, error });
    fb.className = error ? 'link-feedback error' : 'link-feedback';
    fb.textContent = text;
  };
  input.addEventListener('input', () => {
    linkDrafts.set(id, input.value);
    linkFeedback.delete(id);
    fb.textContent = '';
  });
  const submit = async (): Promise<void> => {
    const url = input.value.trim();
    if (!url) return;
    go.disabled = true;
    setFeedback('Opening…', false);
    const err = await api.loginNavigate(id, url);
    go.disabled = false;
    if (err) {
      setFeedback(err, true);
    } else {
      linkDrafts.delete(id);
      input.value = '';
      setFeedback('Opened in the login window.', false);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  });
  const go = button('Open', 'btn primary small', () => void submit());
  row.append(input, go);
  box.append(row, fb);
  return box;
}

function render(): void {
  if (!state) return;
  const now = Date.now();
  const rec = recommendAccount(state.accounts);

  const recEl = $('recommended');
  recEl.hidden = false;
  recEl.replaceChildren();
  if (rec) {
    recEl.className = firstPaint ? 'recommended enter' : 'recommended';
    const left = el('div', 'rec-left');
    const label = el('div', 'label');
    label.append(el('span', 'pulse'), document.createTextNode('Recommended Account'));
    left.append(label);
    left.append(el('div', 'name', rec.name));
    recEl.append(left);
    const p = effectivePercent(rec);
    const right = el('div', 'rec-right');
    if (p !== null) {
      right.append(el('div', 'big', `${Math.round(100 - p)}%`));
      right.append(el('div', 'sub', 'capacity left'));
    }
    if (state.claudeCliFound) {
      const tb = button('>_ Terminal', 'btn primary small rec-term', () => void openTerminal(rec.id), rec.terminalBusy || rec.windowOpen);
      tb.title = `Open Claude Code as ${rec.name}`;
      right.append(tb);
    }
    recEl.append(right);
  } else {
    recEl.className = 'recommended none';
    const left = el('div', 'rec-left');
    left.append(el('div', 'label', 'Recommended Account'));
    left.append(el('div', 'sub', 'No account with readable usage yet'));
    recEl.append(left);
  }

  const list = $('accounts');
  // Keep focus/caret in a "paste link" box across re-renders.
  const active = document.activeElement as HTMLInputElement | null;
  const focusedLink = active?.dataset?.['linkFor'];
  const caret = focusedLink ? (active?.selectionStart ?? null) : null;
  list.replaceChildren(...state.accounts.map((a) => renderCard(a, rec?.id ?? null, now)));
  if (focusedLink) {
    const again = list.querySelector<HTMLInputElement>(`input[data-link-for="${focusedLink}"]`);
    if (again) {
      again.focus();
      if (caret !== null) again.setSelectionRange(caret, caret);
    }
  }

  const notice = $('notice');
  if (!state.browserName) {
    notice.hidden = false;
    notice.textContent = 'Microsoft Edge or Google Chrome is required to read usage. Please install one.';
  } else if (!state.claudeCliFound) {
    notice.hidden = false;
    notice.textContent = 'Claude Code (claude CLI) not found — install it to open terminals per account.';
  } else {
    notice.hidden = true;
  }

  $('last-updated').textContent = state.lastUpdatedAt
    ? `Last updated: ${formatAgo(state.lastUpdatedAt, now)}`
    : 'Last updated: –';
  const interval = state.settings.refreshIntervalMinutes;
  $('auto-refresh').textContent = interval > 0 ? `Auto: ${interval} min` : 'Auto: off';

  $('btn-refresh').classList.toggle('spinning', state.refreshing);
  ($('btn-add-account') as HTMLButtonElement).disabled = state.accounts.length >= 10;
  applyLook(state.settings);
  firstPaint = false;
}

/* ------------------------------- settings -------------------------------- */

function form(): HTMLFormElement {
  return $('settings-form') as HTMLFormElement;
}

function fillSettings(s: Settings): void {
  const f = form();
  const list = $('account-names');
  list.replaceChildren(
    ...s.accountIds.map((id) => {
      const row = el('div', 'name-row');
      const label = el('label');
      label.append(el('span', '', `#${id}`));
      const input = el('input');
      input.type = 'text';
      input.name = `name${id}`;
      input.maxLength = 40;
      input.required = true;
      input.value = s.accountNames[id] ?? `Account ${id}`;
      label.append(input);
      row.append(label);
      const rm = button('Remove', 'btn small danger', () => {
        if (s.accountIds.length <= 1) return;
        if (!window.confirm(`Remove "${s.accountNames[id]}"? Its saved login on this PC will be deleted.`)) return;
        void api.removeAccount(id);
      });
      rm.disabled = s.accountIds.length <= 1;
      row.append(rm);
      return row;
    }),
  );
  (f.elements.namedItem('interval') as HTMLInputElement).value = String(s.refreshIntervalMinutes);
  (f.elements.namedItem('launchAtStartup') as HTMLInputElement).checked = s.launchAtStartup;
  (f.elements.namedItem('alwaysOnTop') as HTMLInputElement).checked = s.alwaysOnTop;
  (f.elements.namedItem('minimizeToTray') as HTMLInputElement).checked = s.minimizeToTray;
  (f.elements.namedItem('showBrowserOnRefresh') as HTMLInputElement).checked = s.showBrowserOnRefresh;
  const op = f.elements.namedItem('windowOpacity') as HTMLInputElement;
  op.value = String(s.windowOpacity);
  $('opacity-value').textContent = `${s.windowOpacity}%`;
  if (state) {
    $('about-browser').textContent = state.browserName
      ? `Browser used for reading usage: ${state.browserName}`
      : 'No compatible browser found (install Edge or Chrome).';
    $('about-version').textContent = `Claude Usage Dashboard v${state.appVersion}`;
  }
}

function readSettings(): Settings {
  const f = form();
  const v = (n: string): string => (f.elements.namedItem(n) as HTMLInputElement).value;
  const c = (n: string): boolean => (f.elements.namedItem(n) as HTMLInputElement).checked;
  const ids = state?.settings.accountIds ?? [];
  const accountNames: Record<number, string> = {};
  for (const id of ids) accountNames[id] = v(`name${id}`);
  return {
    accountIds: ids,
    accountNames,
    refreshIntervalMinutes: Number(v('interval')),
    launchAtStartup: c('launchAtStartup'),
    alwaysOnTop: c('alwaysOnTop'),
    minimizeToTray: c('minimizeToTray'),
    showBrowserOnRefresh: c('showBrowserOnRefresh'),
    windowOpacity: Number(v('windowOpacity')),
  };
}

/** Applies window-level looks (opacity, pin state) from settings. */
function applyLook(s: Settings): void {
  document.documentElement.style.setProperty('--alpha', String(s.windowOpacity / 100));
  const pin = $('btn-pin');
  pin.classList.toggle('active', s.alwaysOnTop);
  pin.setAttribute('aria-pressed', String(s.alwaysOnTop));
  pin.title = s.alwaysOnTop ? 'Pinned on top — click to unpin' : 'Pin on top of other windows';
}

function toggleSettings(open: boolean): void {
  settingsOpen = open;
  $('settings').hidden = !open;
  if (open && state) fillSettings(state.settings);
}

/* --------------------------------- init ---------------------------------- */

async function init(): Promise<void> {
  $('btn-refresh').addEventListener('click', () => void api.refreshAll());
  $('btn-settings').addEventListener('click', () => toggleSettings(!settingsOpen));
  $('btn-pin').addEventListener('click', () => {
    if (!state) return;
    void api.saveSettings({ ...state.settings, alwaysOnTop: !state.settings.alwaysOnTop });
  });
  // Live preview while dragging the transparency slider.
  (form().elements.namedItem('windowOpacity') as HTMLInputElement).addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    $('opacity-value').textContent = `${v}%`;
    document.documentElement.style.setProperty('--alpha', String(v / 100));
  });
  $('btn-settings-close').addEventListener('click', () => toggleSettings(false));
  $('btn-add-account').addEventListener('click', () => void api.addAccount());
  $('btn-minimize').addEventListener('click', () => api.minimize());
  $('btn-close').addEventListener('click', () => api.close());
  form().addEventListener('submit', (e) => {
    e.preventDefault();
    void api.saveSettings(readSettings()).then(() => toggleSettings(false));
  });

  api.onStateChanged((s) => {
    const idsChanged = state?.settings.accountIds.join(',') !== s.settings.accountIds.join(',');
    state = s;
    render();
    if (settingsOpen && idsChanged) fillSettings(s.settings);
  });
  state = await api.getState();
  render();

  // Tick every 30s so relative times ("3h 12m", "2m ago") stay current.
  setInterval(render, 30_000);
}

void init();
