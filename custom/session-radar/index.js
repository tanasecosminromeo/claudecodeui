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
.sr-summary{display:flex;align-items:center;gap:10px;padding:2px 12px 4px;font-size:11px;font-variant-numeric:tabular-nums;color:hsl(var(--muted-foreground));white-space:nowrap;overflow:hidden}
.sr-stat{display:inline-flex;align-items:center;gap:3px;flex:0 0 auto}
.sr-stat svg{width:12px;height:12px;flex:0 0 auto;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.sr-stat.sr-warn{color:#d97706;font-weight:600}
.sr-head.sr-toggle{width:100%;border:0;background:none;cursor:pointer;font-family:inherit}
.sr-head.sr-toggle:hover{background:hsl(var(--accent))}
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
.sr-other .sr-dot{background:hsl(var(--muted-foreground)/.35)}
.sr-chev{flex:0 0 14px;width:14px;height:14px;margin:1px -4px 0 -6px;border:0;background:none;color:hsl(var(--muted-foreground));font:inherit;font-size:10px;line-height:14px;cursor:pointer;padding:0}
.sr-chev:hover{color:hsl(var(--foreground))}
.sr-tree{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;padding:0 8px 4px 20px;border-left:2px solid transparent}
.sr-node{display:flex;gap:6px;align-items:baseline;white-space:nowrap;line-height:17px}
.sr-node-chev{flex:0 0 10px;width:10px;border:0;background:none;padding:0;color:hsl(var(--muted-foreground));font:inherit;font-size:9px;cursor:pointer}
.sr-node-pad{flex:0 0 10px}
.sr-cmd{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.sr-nmeta{flex:0 0 auto;color:hsl(var(--muted-foreground))}
.sr-node.sr-dead{opacity:.55}
.sr-node.sr-fail .sr-nmeta{color:#dc2626;opacity:1}
.sr-tree-note{padding:2px 0 4px;color:hsl(var(--muted-foreground));white-space:normal}
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

const SVG_NS = 'http://www.w3.org/2000/svg';
// Lucide-style 24px stroke paths.
const ICONS = {
  live: 'M22 12h-4l-3 9L9 3l-3 9H2',
  alert: 'M12 9v4 M12 17h.01 M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  claude: 'M6 19v-3 M10 19v-3 M14 19v-3 M18 19v-3 M2 15h20 M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z',
  task: 'M4 17l6-6-6-6 M12 19h8',
  agent: 'M12 8V4H8 M4 8h16v12H4z M2 14h2 M20 14h2 M15 13v2 M9 13v2',
  ram: 'M2 6h20v5H2z M2 13h20v5H2z M6 8.5h.01 M6 15.5h.01',
  load: 'M4 4h16v16H4z M9 9h6v6H9z M9 1v3 M15 1v3 M9 20v3 M15 20v3 M20 9h3 M20 14h3 M1 9h3 M1 14h3',
};
const ENDED_KEY = 'session-radar-ended-open';
const TREE_KEY = 'session-radar-trees'; // { [sid]: { open: 0|1, opened: [pid], closed: [pid] } }
const TREE_POLL_MS = 2000;

function fmtMem(mb) { return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`; }
function fmtTokens(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`; }
function shortModel(m) { return m ? m.replace(/^claude-/, '').replace(/-\d{8}$/, '') : null; }

function fmtDur(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m${Math.round((ms % 60000) / 1000)}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

// ---- process-tree nodes (GET /tree) ----
function nodeTitle(n) {
  const lines = [`pid ${n.pid}`, n.argv, `started ${new Date(n.startMs).toLocaleTimeString()}`];
  if (n.live) lines.push(`memory ${fmtMem(Math.round(n.rssKb / 1024))}`);
  else if (n.endMs) lines.push(`ran ${fmtDur(n.endMs - n.startMs)}, ${n.sig ? `killed by signal ${n.sig}` : `exit ${n.code}`}`);
  else lines.push('ended (no exit recorded)');
  return lines.join('\n');
}

function nodeMeta(n, now) {
  if (n.live) return n.rssKb ? fmtMem(Math.round(n.rssKb / 1024)) : ago(n.startMs, now);
  const dur = n.endMs ? fmtDur(n.endMs - n.startMs) : '';
  const status = n.sig ? `sig ${n.sig}` : n.code ? `exit ${n.code}` : '';
  return [dur, status].filter(Boolean).join(' · ');
}

function rowTitle(s, now) {
  const lines = [s.title, s.cwd || '', `session ${s.sessionId}`];
  if (!s.live) return lines.filter(Boolean).join('\n');
  lines.push(`pid ${s.pids.join(', ')}${s.entrypoint ? ` · ${s.entrypoint}` : ''}${s.version ? ` · v${s.version}` : ''}`);
  if (s.startedAt) lines.push(`up ${ago(s.startedAt, now).replace('now', '<1m')}`);
  if (s.rssMb != null) lines.push(`memory ${fmtMem(s.rssMb)} across ${s.procs} process${s.procs === 1 ? '' : 'es'}`);
  const cfg = [shortModel(s.model), s.mode, s.branch].filter(Boolean).join(' · ');
  if (cfg) lines.push(cfg);
  if (s.contextTokens) lines.push(`context ${fmtTokens(s.contextTokens)} tokens`);
  if (s.agents) lines.push(`${s.agents} agent${s.agents === 1 ? '' : 's'} running`);
  for (const c of s.commands || []) lines.push(`running: ${c}`);
  if (s.archived) lines.push('archived in CloudCLI');
  return lines.filter(Boolean).join('\n');
}

const STATE_LABEL = { waiting: 'needs you', busy: 'working', idle: 'idle', other: 'other process', ended: 'ended' };

// tree = { isOpen(sid), toggle(sid) }: the row's chevron for its process tree (live rows only).
function rowEl(doc, s, now, currentId, onOpen, onMenu, tree) {
  const appId = s.appSessionId || s.sessionId;
  const row = doc.createElement('div');
  row.className = `sr-row sr-${s.state}${appId === currentId || s.sessionId === currentId ? ' sr-current' : ''}`;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.title = rowTitle(s, now);
  row.dataset.sid = s.sessionId;
  const dot = doc.createElement('span'); dot.className = 'sr-dot';
  const main = doc.createElement('span'); main.className = 'sr-main';
  const title = doc.createElement('div'); title.className = 'sr-title'; title.textContent = s.title;
  const meta = doc.createElement('div'); meta.className = 'sr-meta';
  const parts = [];
  if (s.project) parts.push(s.project);
  parts.push(ago(s.lastMessage || s.lastActivity, now));
  if (s.tasks > 0) parts.push(`${s.tasks} task${s.tasks > 1 ? 's' : ''} running`);
  if (s.agents > 0) parts.push(`${s.agents} agent${s.agents > 1 ? 's' : ''}`);
  if (s.live && s.rssMb != null) parts.push(fmtMem(s.rssMb));
  if (s.live && s.branch) parts.push(s.branch);
  if (s.archived) parts.push('archived');
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
  row.append(dot, main);
  if (!s.other) row.append(more); // an unregistered process has no CloudCLI session to act on
  if (s.live && tree) {
    const chev = doc.createElement('button');
    chev.type = 'button';
    chev.className = 'sr-chev';
    const isOpen = tree.isOpen(s.sessionId);
    chev.textContent = isOpen ? '▾' : '▸';
    chev.setAttribute('aria-expanded', String(isOpen));
    chev.setAttribute('aria-label', `${isOpen ? 'Hide' : 'Show'} processes of ${s.title}`);
    chev.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); tree.toggle(s.sessionId); });
    row.prepend(chev);
  }
  const open = (e) => { if (s.other || row.querySelector('.sr-rename')) return; e.preventDefault(); onOpen(appId); };
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
 * fetchData(): Promise<{now, machine, sessions}>; stopSession(sessionId) kills a live session's process;
 * fetchTree(sid): Promise<{now, history, roots, nodes, truncated}> (optional: without it rows have no chevron).
 * Returns { destroy, refresh }.
 */
export function renderRadar(container, { fetchData, stopSession, fetchTree, onOpen = (id) => openSession(id) } = {}) {
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

  // ---- process trees (one per expanded live row), polled every TREE_POLL_MS while open ----
  const trees = new Map(); // sid -> { data, json, timer, error }
  function treeState() {
    try { return JSON.parse(win.localStorage.getItem(TREE_KEY) || '{}') || {}; } catch { return {}; }
  }
  function saveTreeState(st) { try { win.localStorage.setItem(TREE_KEY, JSON.stringify(st)); } catch { /* storage blocked */ } }
  function sidState(sid) { const st = treeState(); return st[sid] || { open: 0, opened: [], closed: [] }; }
  function setSidState(sid, patch) { const st = treeState(); st[sid] = { ...sidState(sid), ...patch }; saveTreeState(st); }
  const treeApi = {
    isOpen: (sid) => !!fetchTree && sidState(sid).open === 1,
    toggle(sid) {
      const open = !treeApi.isOpen(sid);
      setSidState(sid, { open: open ? 1 : 0 });
      if (!open) stopTree(sid);
      forceRefresh();
    },
  };
  function stopTree(sid) {
    const t = trees.get(sid);
    if (t) { win.clearTimeout(t.timer); trees.delete(sid); }
  }
  function ensureTree(sid) {
    if (trees.has(sid) || !fetchTree) return;
    const t = { data: null, json: '', timer: null, error: null };
    trees.set(sid, t);
    const poll = async () => {
      if (dead || trees.get(sid) !== t) return;
      try {
        const data = await fetchTree(sid);
        if (dead || trees.get(sid) !== t) return;
        const json = JSON.stringify(data.nodes.map((n) => [n.pid, n.parent, n.argv, n.live, n.endMs, n.code]));
        t.error = null;
        if (json !== t.json) { t.json = json; t.data = data; drawTrees(sid); }
      } catch (err) {
        if (dead || trees.get(sid) !== t) return;
        t.error = err.message || String(err); t.json = ''; drawTrees(sid);
      } finally {
        if (!dead && trees.get(sid) === t) t.timer = win.setTimeout(poll, TREE_POLL_MS);
      }
    };
    poll();
  }
  function drawTrees(sid) {
    root.querySelectorAll('.sr-tree').forEach((el) => { if (el.dataset.sid === sid) fillTree(el, sid); });
  }
  function treeEl(sid) {
    const el = doc.createElement('div');
    el.className = 'sr-tree';
    el.dataset.sid = sid;
    fillTree(el, sid);
    ensureTree(sid);
    return el;
  }
  function fillTree(el, sid) {
    const t = trees.get(sid);
    const note = (text) => Object.assign(doc.createElement('div'), { className: 'sr-tree-note', textContent: text });
    if (!t || (!t.data && !t.error)) { el.replaceChildren(note('Loading processes…')); return; }
    if (t.error) { el.replaceChildren(note(`Processes unavailable: ${t.error}`)); return; }
    const { nodes, history, truncated, now: tnow } = t.data;
    const st = sidState(sid);
    const known = new Set(nodes.map((n) => n.pid));
    const kids = new Map(); // parent pid (null = top) -> children
    for (const n of nodes) {
      const key = n.parent != null && known.has(n.parent) ? n.parent : null;
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(n);
    }
    // Live branches start open, finished ones collapsed; the user's clicks win.
    const isOpen = (n) => (st.opened.includes(n.pid) ? true : st.closed.includes(n.pid) ? false : n.live);
    const out = [];
    const walk = (parentKey, depth) => {
      for (const n of kids.get(parentKey) || []) {
        const line = doc.createElement('div');
        line.className = `sr-node${n.live ? '' : ' sr-dead'}${!n.live && (n.code || n.sig) ? ' sr-fail' : ''}`;
        line.style.paddingLeft = `${depth * 10}px`;
        line.title = nodeTitle(n);
        const children = kids.get(n.pid) || [];
        if (children.length) {
          const open = isOpen(n);
          const c = doc.createElement('button');
          c.type = 'button'; c.className = 'sr-node-chev'; c.textContent = open ? '▾' : '▸';
          c.setAttribute('aria-expanded', String(open));
          c.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${n.cmd}`);
          c.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            const s = sidState(sid);
            const opened = s.opened.filter((p) => p !== n.pid); const closed = s.closed.filter((p) => p !== n.pid);
            if (open) closed.push(n.pid); else opened.push(n.pid);
            setSidState(sid, { opened, closed });
            fillTree(el, sid);
          });
          line.append(c);
        } else {
          line.append(Object.assign(doc.createElement('span'), { className: 'sr-node-pad' }));
        }
        line.append(
          Object.assign(doc.createElement('span'), { className: 'sr-cmd', textContent: n.cmd }),
          Object.assign(doc.createElement('span'), { className: 'sr-nmeta', textContent: nodeMeta(n, tnow || Date.now()) }),
        );
        out.push(line);
        if (children.length && isOpen(n)) walk(n.pid, depth + 1);
      }
    };
    walk(null, 0);
    if (!history) out.push(note('Command history needs the exec tracer (make exec-tracer)'));
    if (truncated) out.push(note(`${truncated} older process${truncated === 1 ? '' : 'es'} not shown`));
    el.replaceChildren(...out);
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
    if (s.live && stopSession) {
      sep();
      let stopArmed = false;
      item('Stop session (kill process)', {
        hint: `Sends SIGTERM to pid ${s.pids.join(', ')}; the transcript is kept`,
        danger: true,
        onClick: (b) => {
          if (!stopArmed) {
            stopArmed = true;
            b.firstChild.textContent = 'Click again to stop it now';
            return;
          }
          runAction('Stop', () => stopSession(s.sessionId));
        },
      });
    }
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
      const json = JSON.stringify([data.machine, data.sessions]) + currentSessionId(win) + endedOpen();
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

  function endedOpen() {
    try { return win.localStorage.getItem(ENDED_KEY); } catch { return null; }
  }

  function section(label, count) {
    const h = doc.createElement(label.includes('Ended') ? 'button' : 'div');
    if (h.tagName === 'BUTTON') h.type = 'button';
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
    ['other', 'Other agent processes'],
    ['ended', 'Ended · 24h'],
  ];

  function draw({ now, machine, sessions }) {
    const cur = currentSessionId(win);
    const nodes = [];
    for (const sid of [...trees.keys()]) if (!sessions.some((s) => s.sessionId === sid && s.live)) stopTree(sid);
    const pushRow = (s) => {
      nodes.push(rowEl(doc, s, now, cur, onOpen, openMenu, treeApi));
      if (s.live && treeApi.isOpen(s.sessionId)) nodes.push(treeEl(s.sessionId));
    };
    const live = sessions.filter((s) => s.live && !s.other); // the summary is about sessions
    if (live.length) {
      const mb = live.reduce((n, s) => n + (s.rssMb || 0), 0);
      const needs = live.filter((s) => s.state === 'waiting').length;
      const tasks = live.reduce((n, s) => n + (s.tasks || 0), 0);
      const agents = live.reduce((n, s) => n + (s.agents || 0), 0);
      const sum = doc.createElement('div');
      sum.className = 'sr-summary';
      const stat = (icon, text, title, cls) => {
        const el = doc.createElement('span');
        el.className = `sr-stat${cls ? ` ${cls}` : ''}`;
        el.title = title;
        const svg = doc.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        const path = doc.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', ICONS[icon]);
        svg.append(path);
        el.append(svg, doc.createTextNode(text));
        sum.append(el);
      };
      stat('live', String(live.length), `${live.length} live Claude session${live.length === 1 ? '' : 's'}`);
      if (needs) stat('alert', String(needs), `${needs} need${needs === 1 ? 's' : ''} you`, 'sr-warn');
      stat('claude', fmtMem(mb), 'Memory used by all live Claude sessions (processes and their children)');
      if (tasks) stat('task', String(tasks), `${tasks} background command${tasks === 1 ? '' : 's'} running`);
      if (agents) stat('agent', String(agents), `${agents} agent${agents === 1 ? '' : 's'} running`);
      if (machine && machine.memTotalMb) {
        const used = machine.memTotalMb - machine.memAvailMb;
        stat('ram', `${fmtMem(used)}/${fmtMem(machine.memTotalMb)}`, `Machine RAM in use; Claude is ${Math.round((mb / machine.memTotalMb) * 100)}% of it`);
        stat('load', `${machine.load[0]}/${machine.cpus}`, `Load average (1 min) on ${machine.cpus} CPUs`);
      }
      nodes.push(sum);
    }
    for (const [state, label] of GROUPS) {
      const group = sessions.filter((s) => s.state === state); // server already sorted by last message
      if (group.length === 0) continue;
      if (state !== 'ended') {
        nodes.push(section(label, group.length));
        group.forEach(pushRow);
        continue;
      }
      // Ended work is history: one click away, collapsed unless asked for.
      let open = false;
      try { open = win.localStorage.getItem(ENDED_KEY) === '1'; } catch { /* storage blocked */ }
      const head = section(`${open ? '▾' : '▸'} ${label}`, group.length);
      head.classList.add('sr-toggle');
      head.setAttribute('role', 'button');
      head.tabIndex = 0;
      head.setAttribute('aria-expanded', String(open));
      const toggle = () => {
        try { win.localStorage.setItem(ENDED_KEY, open ? '0' : '1'); } catch { /* storage blocked */ }
        forceRefresh();
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      nodes.push(head);
      if (open) group.forEach(pushRow);
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
      for (const sid of [...trees.keys()]) stopTree(sid);
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
    stopSession: (sessionId) => api.rpc('POST', 'stop', { sessionId }),
    fetchTree: (sid) => api.rpc('GET', `tree?sid=${encodeURIComponent(sid)}`),
  });
}

export function unmount() {
  handle?.destroy();
  handle = null;
}
