// session-radar frontend. Two consumers:
//  - CloudCLI mounts it as a workspace tab via mount()/unmount();
//  - cloudcli-ui-cleanup's sidebar script imports renderRadar() for the Running view.
const POLL_MS = 5000;
const STYLE_ID = 'session-radar-style';

const CSS = `
.sr-root{font-size:12px;color:hsl(var(--foreground));padding:4px 0}
.sr-head{display:flex;align-items:center;justify-content:space-between;padding:8px 12px 3px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:hsl(var(--muted-foreground))}
.sr-head b{font-weight:600;color:hsl(var(--foreground))}
.sr-row{position:relative;display:flex;gap:8px;align-items:flex-start;width:100%;text-align:left;padding:5px 30px 5px 12px;border-left:2px solid transparent;cursor:pointer;color:inherit;outline:none}
.sr-row:hover,.sr-row:focus-visible,.sr-row.sr-menu-open{background:hsl(var(--accent))}
.sr-row.sr-current{border-left-color:hsl(var(--primary));background:hsl(var(--accent)/.6)}
.sr-dot{flex:0 0 auto;width:7px;height:7px;margin-top:5px;border-radius:50%}
.sr-waiting .sr-dot{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.25);animation:sr-pulse 1.4s ease-in-out infinite}
.sr-busy .sr-dot{background:#10b981}
.sr-idle .sr-dot{background:hsl(var(--muted-foreground)/.55)}
.sr-ended .sr-dot{background:transparent;border:1.5px solid hsl(var(--muted-foreground)/.5)}
.sr-main{min-width:0;flex:1}
.sr-title{font-size:12px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sr-waiting .sr-title{font-weight:600}
.sr-meta{margin-top:1px;font-size:10.5px;line-height:1.3;color:hsl(var(--muted-foreground));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sr-flag{color:#d97706;font-weight:600}
.sr-more{position:absolute;right:4px;top:4px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border:0;background:none;color:hsl(var(--muted-foreground));cursor:pointer;opacity:0;font:600 14px/1 system-ui}
.sr-row:hover .sr-more,.sr-row:focus-within .sr-more,.sr-row.sr-menu-open .sr-more{opacity:1}
.sr-more:hover{background:hsl(var(--muted));color:hsl(var(--foreground))}
@media (hover:none){.sr-more{opacity:.7}}
.sr-rename{width:100%;font:inherit;font-size:12px;padding:1px 4px;border:1px solid hsl(var(--primary));background:hsl(var(--background));color:hsl(var(--foreground));outline:none}
.sr-menu{position:fixed;z-index:2147483001;min-width:210px;max-width:260px;padding:4px;background:hsl(var(--popover, var(--background)));color:hsl(var(--popover-foreground, var(--foreground)));border:1px solid hsl(var(--border));box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px}
.sr-menu-head{padding:5px 8px 6px;border-bottom:1px solid hsl(var(--border));margin-bottom:3px}
.sr-menu-head div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.sr-menu-head small{display:block;margin-top:1px;font-size:10.5px;color:hsl(var(--muted-foreground));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sr-item{display:block;width:100%;text-align:left;padding:6px 8px;border:0;background:none;color:inherit;font:inherit;cursor:pointer}
.sr-item:hover:not(:disabled){background:hsl(var(--accent))}
.sr-item:disabled{opacity:.45;cursor:default}
.sr-item small{display:block;font-size:10.5px;color:hsl(var(--muted-foreground))}
.sr-danger{color:#dc2626}
.sr-sep{height:1px;margin:3px 0;background:hsl(var(--border))}
.sr-empty,.sr-error{padding:18px 12px;color:hsl(var(--muted-foreground));font-size:12px}
.sr-error{color:#dc2626}
.sr-toast{padding:4px 12px;font-size:11px;color:#dc2626}
@keyframes sr-pulse{50%{box-shadow:0 0 0 5px rgba(245,158,11,.05)}}
`;

function authHeaders() {
  let token = null;
  try { token = localStorage.getItem('auth-token'); } catch { /* storage blocked */ }
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function appApi(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
  return data;
}

// Must run synchronously inside the click so the browser still counts it as a user gesture.
function copyText(text) {
  let ok = false;
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (ok) return Promise.resolve(true);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true, () => false);
  }
  return Promise.resolve(false);
}

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}

function ago(ms, now) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const STATE_LABEL = { waiting: 'needs you', busy: 'working', idle: 'idle', ended: 'ended' };

function rowEl(doc, s, now, currentId, onOpen, onMenu) {
  const appId = s.appSessionId || s.sessionId;
  const row = doc.createElement('div');
  row.className = `sr-row sr-${s.state}${appId === currentId || s.sessionId === currentId ? ' sr-current' : ''}`;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.title = `${s.title}\n${s.cwd || ''}\n${s.sessionId}`;
  row.dataset.sid = s.sessionId;
  const dot = doc.createElement('span'); dot.className = 'sr-dot';
  const main = doc.createElement('span'); main.className = 'sr-main';
  const title = doc.createElement('div'); title.className = 'sr-title'; title.textContent = s.title;
  const meta = doc.createElement('div'); meta.className = 'sr-meta';
  const parts = [];
  if (s.project) parts.push(s.project);
  parts.push(ago(s.lastMessage || s.lastActivity, now));
  if (s.tasks > 0) parts.push(`${s.tasks} task${s.tasks > 1 ? 's' : ''} running`);
  if (s.state === 'waiting') {
    const flag = doc.createElement('span'); flag.className = 'sr-flag';
    flag.textContent = s.waitingFor ? `waiting: ${s.waitingFor}` : 'needs you';
    meta.append(flag, doc.createTextNode(' · ' + parts.join(' · ')));
  } else {
    meta.textContent = [STATE_LABEL[s.state], ...parts].filter(Boolean).join(' · ');
  }
  main.append(title, meta);
  const more = doc.createElement('button');
  more.type = 'button';
  more.className = 'sr-more';
  more.textContent = '⋯';
  more.setAttribute('aria-label', `Session options for ${s.title}`);
  more.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onMenu(s, row, more); });
  row.append(dot, main, more);
  const open = (e) => { if (row.querySelector('.sr-rename')) return; e.preventDefault(); onOpen(appId); };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => { if (e.target === row && (e.key === 'Enter' || e.key === ' ')) open(e); });
  return row;
}

function currentSessionId(win) {
  const m = win.location.pathname.match(/\/session\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Default navigation: SPA route change via History API (React Router v6 listens to popstate). */
export function openSession(sessionId, win = window) {
  const url = `/session/${encodeURIComponent(sessionId)}`;
  if (win.location.pathname === url) return;
  win.history.pushState({}, '', url);
  win.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
}

/**
 * Render a live-updating session list into `container`.
 * fetchData(): Promise<{now, sessions}>; returns { destroy, refresh }.
 */
export function renderRadar(container, { fetchData, onOpen = (id) => openSession(id) } = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  ensureStyle(doc);
  const root = doc.createElement('div');
  root.className = 'sr-root';
  container.appendChild(root);
  let timer = null;
  let dead = false;
  let lastJson = '';
  let menu = null; // { el, row, close }
  let busyUi = false; // rename open or action running: pause redraws

  function closeMenu() {
    if (!menu) return;
    menu.row.classList.remove('sr-menu-open');
    menu.el.remove();
    doc.removeEventListener('mousedown', menu.onDown, true);
    doc.removeEventListener('keydown', menu.onKey, true);
    win.removeEventListener('scroll', menu.onScroll, true);
    menu = null;
  }

  function toast(text) {
    const t = doc.createElement('div'); t.className = 'sr-toast'; t.textContent = text;
    root.prepend(t);
    win.setTimeout(() => t.remove(), 4000);
  }

  function startRename(s, row) {
    const title = row.querySelector('.sr-title');
    const input = doc.createElement('input');
    input.className = 'sr-rename';
    input.value = s.title;
    busyUi = true;
    title.replaceChildren(input);
    input.focus(); input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const name = input.value.trim();
      if (save && name && name !== s.title) {
        try {
          await appApi('PUT', `/api/providers/sessions/${encodeURIComponent(s.appSessionId || s.sessionId)}`, { summary: name });
          s.title = name;
        } catch (err) { toast(`Rename failed: ${err.message}`); }
      }
      busyUi = false;
      title.textContent = s.title;
      forceRefresh();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('blur', () => finish(true));
  }

  async function runAction(label, fn) {
    closeMenu();
    busyUi = true;
    try { await fn(); } catch (err) { toast(`${label} failed: ${err.message}`); }
    busyUi = false;
    forceRefresh();
  }

  function openMenu(s, row, anchor) {
    const wasOpen = menu && menu.row === row;
    closeMenu();
    if (wasOpen) return;
    const appId = s.appSessionId || s.sessionId;
    const live = s.state === 'busy' || s.state === 'waiting';
    const el = doc.createElement('div');
    el.className = 'sr-menu';
    el.setAttribute('role', 'menu');
    const head = doc.createElement('div'); head.className = 'sr-menu-head';
    const h1 = doc.createElement('div'); h1.textContent = s.title;
    const h2 = doc.createElement('small'); h2.textContent = `Claude session · ${s.sessionId}`;
    head.append(h1, h2);
    el.append(head);

    const item = (label, { hint, danger, disabled, onClick } = {}) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `sr-item${danger ? ' sr-danger' : ''}`;
      b.textContent = label;
      if (hint) { const sm = doc.createElement('small'); sm.textContent = hint; b.append(sm); }
      b.disabled = !!disabled;
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(b); });
      el.append(b);
      return b;
    };
    const sep = () => { const d = doc.createElement('div'); d.className = 'sr-sep'; el.append(d); };
    const liveHint = live ? 'Not while the session is running' : undefined;

    item('Rename session', { onClick: () => { closeMenu(); startRename(s, row); } });
    item('Copy Claude session ID', {
      hint: s.sessionId,
      onClick: async (b) => {
        const ok = await copyText(s.sessionId);
        b.firstChild.textContent = ok ? 'Copied' : 'Copy failed';
        win.setTimeout(closeMenu, 700);
      },
    });
    item('Fork session', {
      hint: liveHint || 'Continue from a copy, leaving this one untouched',
      disabled: live,
      onClick: () => runAction('Fork', async () => {
        const res = await appApi('POST', `/api/providers/sessions/${encodeURIComponent(appId)}/fork`, {});
        const id = res && res.data && res.data.sessionId;
        if (id) onOpen(id);
      }),
    });
    sep();
    item('Archive session', {
      hint: liveHint || 'Hide it; history is kept',
      disabled: live,
      onClick: () => runAction('Archive', () => appApi('DELETE', `/api/providers/sessions/${encodeURIComponent(appId)}`)),
    });
    let armed = false;
    item('Delete permanently', {
      hint: liveHint || 'Removes the transcript',
      danger: true,
      disabled: live,
      onClick: (b) => {
        if (!armed) {
          armed = true;
          b.firstChild.textContent = 'Click again to delete for good';
          return;
        }
        runAction('Delete', () => appApi('DELETE', `/api/providers/sessions/${encodeURIComponent(appId)}?force=true`));
      },
    });

    doc.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const mw = el.offsetWidth; const mh = el.offsetHeight;
    let left = Math.min(r.right - mw, win.innerWidth - mw - 8); left = Math.max(8, left);
    let top = r.bottom + 4; if (top + mh > win.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    el.style.left = `${left}px`; el.style.top = `${top}px`;
    row.classList.add('sr-menu-open');
    const onDown = (e) => { if (!el.contains(e.target) && e.target !== anchor) closeMenu(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
    const onScroll = (e) => { if (!el.contains(e.target)) closeMenu(); };
    doc.addEventListener('mousedown', onDown, true);
    doc.addEventListener('keydown', onKey, true);
    win.addEventListener('scroll', onScroll, true);
    menu = { el, row, close: closeMenu, onDown, onKey, onScroll };
  }

  function forceRefresh() { lastJson = ''; win.clearTimeout(timer); refresh(); }

  async function refresh() {
    if (dead) return;
    try {
      const data = await fetchData();
      if (dead) return;
      if (busyUi || menu) return; // don't yank the row out from under an open menu/rename
      const json = JSON.stringify(data.sessions) + currentSessionId(win);
      if (json === lastJson) return; // nothing changed: keep DOM (and hover) stable
      lastJson = json;
      draw(data);
    } catch (err) {
      if (dead) return;
      lastJson = '';
      root.replaceChildren(Object.assign(doc.createElement('div'), { className: 'sr-error', textContent: `Sessions unavailable: ${err.message || err}` }));
    } finally {
      if (!dead) timer = win.setTimeout(refresh, POLL_MS);
    }
  }

  function section(label, count) {
    const h = doc.createElement('div');
    h.className = 'sr-head';
    h.append(doc.createTextNode(label));
    const c = doc.createElement('b'); c.textContent = String(count);
    h.append(c);
    return h;
  }

  const GROUPS = [
    ['waiting', 'Needs you'],
    ['busy', 'Running'],
    ['idle', 'Idle'],
    ['ended', 'Ended · 24h'],
  ];

  function draw({ now, sessions }) {
    const cur = currentSessionId(win);
    const nodes = [];
    for (const [state, label] of GROUPS) {
      const group = sessions.filter((s) => s.state === state); // server already sorted by last message
      if (group.length === 0) continue;
      nodes.push(section(label, group.length));
      group.forEach((s) => nodes.push(rowEl(doc, s, now, cur, onOpen, openMenu)));
    }
    if (nodes.length === 0) {
      nodes.push(Object.assign(doc.createElement('div'), { className: 'sr-empty', textContent: 'No Claude sessions active in the last 24 hours.' }));
    }
    root.replaceChildren(...nodes);
  }

  const onNav = () => { lastJson = ''; win.clearTimeout(timer); refresh(); };
  win.addEventListener('popstate', onNav);
  refresh();

  return {
    refresh: onNav,
    destroy() {
      dead = true;
      closeMenu();
      win.clearTimeout(timer);
      win.removeEventListener('popstate', onNav);
      root.remove();
    },
  };
}

// ---- CloudCLI tab plugin contract ----
let handle = null;

export function mount(container, api) {
  handle = renderRadar(container, {
    fetchData: () => api.rpc('GET', 'sessions'),
  });
}

export function unmount() {
  handle?.destroy();
  handle = null;
}
