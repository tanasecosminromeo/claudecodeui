// claude-usage frontend.
//  - CloudCLI mounts it as the "Usage" workspace tab (mount/unmount);
//  - custom/ui-cleanup/cleanup.js imports renderUsage() for the header meter's popover.
const POLL_MS = 60_000;
const STYLE_ID = 'claude-usage-style';

const CSS = `
.cu-root{font-size:12px;color:hsl(var(--foreground));padding:10px 12px;display:flex;flex-direction:column;gap:10px}
.cu-top{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:hsl(var(--muted-foreground))}
.cu-refresh{border:1px solid hsl(var(--border));background:none;color:inherit;font:inherit;padding:2px 8px;cursor:pointer}
.cu-refresh:hover{background:hsl(var(--accent));color:hsl(var(--foreground))}
.cu-card{border:1px solid hsl(var(--border));padding:9px 10px;background:hsl(var(--card, var(--background)))}
.cu-card.cu-active{border-color:hsl(var(--primary));box-shadow:inset 3px 0 0 hsl(var(--primary))}
.cu-head{display:flex;align-items:baseline;gap:6px;margin-bottom:7px;min-width:0}
.cu-num{font-weight:600;color:hsl(var(--muted-foreground))}
.cu-email{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.cu-badge{margin-left:auto;flex:0 0 auto;font-size:9.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:1px 5px;background:hsl(var(--primary));color:hsl(var(--primary-foreground))}
.cu-badge.cu-muted{background:hsl(var(--muted));color:hsl(var(--muted-foreground))}
.cu-switch{margin-left:auto;flex:0 0 auto;font-size:10.5px;padding:1px 7px}
.cu-switch.cu-armed{border-color:#f59e0b;color:#d97706}
.cu-switch:disabled{opacity:.6;cursor:default}
.cu-org{font-size:10.5px;color:hsl(var(--muted-foreground));margin:-5px 0 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cu-win{margin-top:6px}
.cu-line{display:flex;justify-content:space-between;gap:8px;font-size:11px}
.cu-line b{font-weight:600}
.cu-sub{font-size:10.5px;color:hsl(var(--muted-foreground));margin-top:2px}
.cu-bar{position:relative;height:6px;margin-top:3px;background:hsl(var(--muted))}
.cu-fill{position:absolute;left:0;top:0;bottom:0}
.cu-exp{position:absolute;top:-2px;bottom:-2px;width:2px;background:hsl(var(--foreground)/.55)}
.cu-ok{background:#10b981}.cu-warn{background:#f59e0b}.cu-bad{background:#ef4444}
.cu-t-ok{color:#059669}.cu-t-warn{color:#d97706}.cu-t-bad{color:#dc2626}
.cu-err{color:#dc2626;font-size:11px}
.cu-def{flex:0 0 auto;font-size:10px;padding:0 5px;opacity:.75}
.cu-def.cu-on{opacity:1;border-color:hsl(var(--primary));color:hsl(var(--primary))}
.cu-pause{font-size:10.5px;color:#d97706;margin:-3px 0 6px}
`;

export function level(pct) {
  if (pct == null) return 'ok';
  return pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok';
}

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function windowEl(doc, label, w, withPace) {
  const box = el(doc, 'div', 'cu-win');
  if (!w || w.pct == null) {
    box.append(el(doc, 'div', 'cu-sub', `${label}: no data`));
    return box;
  }
  const lv = level(w.pct);
  const line = el(doc, 'div', 'cu-line');
  const left = el(doc, 'span', null, label);
  const right = el(doc, 'b', `cu-t-${lv}`, `${Math.round(w.pct)}%`);
  line.append(left, right);
  const bar = el(doc, 'div', 'cu-bar');
  const fill = el(doc, 'div', `cu-fill cu-${lv}`);
  fill.style.width = `${Math.max(0, Math.min(100, w.pct))}%`;
  bar.append(fill);
  if (withPace && w.expectedPct != null) {
    const exp = el(doc, 'div', 'cu-exp');
    exp.style.left = `calc(${Math.max(0, Math.min(100, w.expectedPct))}% - 1px)`;
    exp.title = `Even pace would be ${Math.round(w.expectedPct)}% by now`;
    bar.append(exp);
  }
  const parts = [];
  if (w.resetSinceObserved) parts.push('reset since');
  if (w.countdown) parts.push(`resets in ${w.countdown}${w.clock ? ` (${w.clock})` : ''}`);
  if (w.pct >= 100) parts.push('limit reached');
  else if (withPace && w.willLastToReset === false && w.projectedExhaustionAt) parts.push(`runs out ~${fmtDate(w.projectedExhaustionAt)}`);
  else if (withPace && w.willLastToReset === true) parts.push('lasts to reset');
  if (withPace && w.aheadOfPace === true && w.pct < 100) parts.push('ahead of pace');
  box.append(line, bar, el(doc, 'div', 'cu-sub', parts.join(' · ')));
  return box;
}

// Two clicks (Switch → Switch to #n?) so a stray click can't swap the machine's Claude login.
function switchButton(doc, a, onSwitch) {
  const btn = el(doc, 'button', 'cu-refresh cu-switch', 'Switch');
  btn.type = 'button';
  btn.title = `Make #${a.number} the active Claude account on this machine (new sessions use it)`;
  let armed = null;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!armed) {
      btn.textContent = `Switch to #${a.number}?`;
      btn.classList.add('cu-armed');
      armed = setTimeout(() => { armed = null; btn.textContent = 'Switch'; btn.classList.remove('cu-armed'); }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    btn.disabled = true;
    btn.textContent = 'Switching…';
    onSwitch(a.number, btn);
  });
  return btn;
}

function cardEl(doc, a, onSwitch, auto, onDefault) {
  const card = el(doc, 'div', `cu-card${a.active ? ' cu-active' : ''}`);
  const head = el(doc, 'div', 'cu-head');
  head.append(el(doc, 'span', 'cu-num', `#${a.number}`), el(doc, 'span', 'cu-email', a.email || '(no email)'));
  const isDefault = !!auto && auto.defaultAccount === a.number;
  if (a.active) head.append(el(doc, 'span', 'cu-badge', 'active'));
  else if (onSwitch) head.append(switchButton(doc, a, onSwitch));
  if (onDefault) {
    const d = el(doc, 'button', `cu-refresh cu-def${isDefault ? ' cu-on' : ''}`, isDefault ? '★ default' : '☆ default');
    d.type = 'button';
    d.title = isDefault ? 'Default account: used until 99% of its 5-hour window, then auto-switches. Click to clear.'
      : `Make #${a.number} the default account (auto-switches away at 99% of 5 hours, back when it resets)`;
    d.addEventListener('click', (e) => { e.stopPropagation(); d.disabled = true; onDefault(isDefault ? null : a.number, d); });
    if (a.active || !onSwitch) d.style.marginLeft = 'auto'; // the badge / switch button already took the auto margin otherwise
    head.append(d);
  }
  card.append(head);
  if (isDefault && auto.pinnedToken) card.append(el(doc, 'div', 'cu-pause', 'Auto-switch off: CLAUDE_CODE_OAUTH_TOKEN is pinned in the service env'));
  else if (isDefault && auto.paused) card.append(el(doc, 'div', 'cu-pause', auto.paused));
  if (a.organizationName && a.organizationName !== `${a.email}'s Organization`) card.append(el(doc, 'div', 'cu-org', a.organizationName));
  if (a.usageStatus && a.usageStatus !== 'ok') card.append(el(doc, 'div', 'cu-err', `usage: ${a.usageStatus}`));
  card.append(windowEl(doc, '5-hour', a.fiveHour, false), windowEl(doc, '7-day', a.sevenDay, true));
  for (const s of a.scoped || []) card.append(windowEl(doc, `7-day · ${s.name || 'model'}`, s, true));
  return card;
}

function fmtAgo(iso) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d) / 60000);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
  return `${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}, ${ago}`;
}

// Codex numbers come from its local session logs, so they're as of the last Codex request here.
function codexCardEl(doc, codex) {
  const card = el(doc, 'div', 'cu-card');
  const head = el(doc, 'div', 'cu-head');
  head.append(el(doc, 'span', 'cu-email', 'Codex'));
  if (codex.planType) head.append(el(doc, 'span', 'cu-badge cu-muted', codex.planType));
  card.append(head, el(doc, 'div', 'cu-org', `as of last Codex request (${fmtAgo(codex.observedAt)})`));
  for (const l of codex.limits || []) {
    const prefix = l.id === 'codex' ? '' : `${l.name} · `;
    for (const w of [l.primary, l.secondary]) {
      if (w) card.append(windowEl(doc, `${prefix}${w.name}`, w, w.windowMinutes >= 1440));
    }
    if (l.reached) card.append(el(doc, 'div', 'cu-err', `${l.name}: ${l.reached} (${fmtDate(l.observedAt)})`));
  }
  return card;
}

/** Codex headline numbers for the header meter's tooltip, or null when Codex isn't used here. */
export function codexSummary(data) {
  const limit = data.codex && (data.codex.limits || []).find((l) => l.id === 'codex');
  if (!limit) return null;
  return { five: limit.primary ? limit.primary.pct : null, seven: limit.secondary ? limit.secondary.pct : null, observedAt: data.codex.observedAt };
}

/** The active account's headline numbers, for the header meter. */
export function summary(data) {
  const a = (data.accounts || []).find((x) => x.active) || (data.accounts || [])[0];
  if (!a) return null;
  const scopedMax = Math.max(0, ...(a.scoped || []).map((s) => s.pct || 0));
  const five = a.fiveHour ? a.fiveHour.pct : null;
  const seven = a.sevenDay ? a.sevenDay.pct : null;
  return { account: a, five, seven, scopedMax, worst: Math.max(five || 0, seven || 0) };
}

/** Render the account cards into `container`; fetchData(force) -> Promise<usage>.
 *  switchAccount(number) -> Promise<usage> adds a Switch button to inactive accounts;
 *  setDefault(number|null) adds the default-account star (auto-switch, see autoswitch.mjs). */
export function renderUsage(container, { fetchData, switchAccount, setDefault, onData, pollMs = POLL_MS } = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  ensureStyle(doc);
  const root = el(doc, 'div', 'cu-root');
  container.appendChild(root);
  let timer = null;
  let dead = false;

  async function refresh(force) {
    if (dead) return;
    win.clearTimeout(timer);
    try {
      draw(await fetchData(force));
    } catch (err) {
      root.replaceChildren(el(doc, 'div', 'cu-err', `Usage unavailable: ${err.message || err}`));
    } finally {
      if (!dead) timer = win.setTimeout(() => refresh(false), pollMs);
    }
  }

  async function onSwitch(number, btn) {
    try {
      const data = await switchAccount(number);
      if (onData) onData(data);
      draw(data);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Switch';
      btn.title = `Switch failed: ${err.message || err}`;
      btn.classList.add('cu-armed');
    }
  }

  async function onDefault(number, btn) {
    try {
      await setDefault(number);
      refresh(true);
    } catch (err) {
      btn.disabled = false;
      btn.title = `Could not set the default: ${err.message || err}`;
    }
  }

  function draw(data) {
    const top = el(doc, 'div', 'cu-top');
    const when = data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
    top.append(el(doc, 'span', null, `${data.codex ? 'Plan usage' : 'Claude plan usage'}${when ? ` · ${when}` : ''}`));
    const btn = el(doc, 'button', 'cu-refresh', 'Refresh');
    btn.type = 'button';
    btn.addEventListener('click', (e) => { e.stopPropagation(); btn.textContent = '…'; refresh(true); });
    top.append(btn);
    const accounts = [...(data.accounts || [])].sort((x, y) => (y.active - x.active) || (x.number - y.number));
    const cards = accounts.map((a) => cardEl(doc, a, switchAccount ? onSwitch : null, data.auto, setDefault ? onDefault : null));
    if (data.codex) cards.push(codexCardEl(doc, data.codex));
    root.replaceChildren(top, ...cards);
  }

  refresh(false);
  return { refresh: () => refresh(true), destroy() { dead = true; win.clearTimeout(timer); root.remove(); } };
}

// ---- CloudCLI tab plugin contract ----
let handle = null;
export function mount(container, api) {
  handle = renderUsage(container, {
    fetchData: (force) => api.rpc('GET', force ? 'usage?refresh=1' : 'usage'),
    switchAccount: (number) => api.rpc('POST', 'switch', { number }),
    setDefault: (number) => api.rpc('PUT', 'default', { defaultAccount: number }),
  });
}
export function unmount() {
  handle?.destroy();
  handle = null;
}
