// share-artefacts frontend: everything published with `share publish` (custom/share/), grouped by
// share, newest first. Two consumers:
//  - CloudCLI mounts it as a workspace tab via mount()/unmount() (hidden by ui-cleanup);
//  - cloudcli-ui-cleanup's sidebar script imports renderArtefacts() in place of the Conversations list.
const POLL_MS = 30000;
const STYLE_ID = 'share-artefacts-style';

const CSS = `
.sa-root{font-size:12px;color:hsl(var(--foreground));padding:4px 0}
.sa-group{padding:6px 0 4px;border-bottom:1px solid hsl(var(--border)/.6)}
.sa-head{display:flex;align-items:center;gap:6px;padding:0 12px;min-width:0}
.sa-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:hsl(var(--muted-foreground)/.55)}
.sa-s-waiting .sa-dot{background:#f59e0b}.sa-s-busy .sa-dot{background:#10b981}
.sa-s-ended .sa-dot,.sa-s-archived .sa-dot{background:transparent;border:1.5px solid hsl(var(--muted-foreground)/.5)}
.sa-title{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.sa-title:hover{text-decoration:underline}
.sa-badge,.sa-tag{flex:0 0 auto;padding:0 5px;font-size:10px;line-height:16px;border:1px solid hsl(var(--border));color:hsl(var(--muted-foreground))}
.sa-s-waiting .sa-badge{color:#d97706;border-color:#f59e0b}.sa-s-busy .sa-badge{color:#059669;border-color:#10b981}
.sa-sub{display:flex;gap:6px;padding:1px 12px 0 25px;font-size:10.5px;color:hsl(var(--muted-foreground));white-space:nowrap;overflow:hidden}
.sa-project{overflow:hidden;text-overflow:ellipsis}.sa-exp{flex:0 0 auto}.sa-exp.sa-gone{color:#dc2626}
.sa-last{padding:2px 12px 0 25px;font-size:11px;font-style:italic;color:hsl(var(--muted-foreground));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sa-actions{display:flex;flex-wrap:wrap;gap:4px;padding:4px 12px 2px 25px}
.sa-btn{border:1px solid hsl(var(--border));background:none;color:hsl(var(--muted-foreground));font:inherit;font-size:10.5px;padding:1px 6px;cursor:pointer}
.sa-btn:hover{color:hsl(var(--foreground));background:hsl(var(--accent))}
.sa-row{display:flex;gap:8px;align-items:baseline;width:100%;padding:4px 12px 4px 25px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sa-row:hover,.sa-row:focus-visible{background:hsl(var(--accent));outline:none}
.sa-row-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sa-age{flex:0 0 auto;font-size:10.5px;color:hsl(var(--muted-foreground))}
.sa-expired{opacity:.5}
.sa-empty,.sa-error{padding:18px 12px;color:hsl(var(--muted-foreground))}.sa-error{color:#dc2626}
.sa-toast{padding:4px 12px;font-size:11px;color:hsl(var(--muted-foreground))}
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style'); s.id = STYLE_ID; s.textContent = CSS;
  doc.head.appendChild(s);
}

function age(ms) {
  const m = Math.max(0, Math.round(ms / 60e3));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const TZ = 'Europe/Bucharest';
const dayOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
function until(iso, now) {
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(d);
  if (dayOf(d) === dayOf(new Date(now))) return `until ${time}`;
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d);
  return `until ${day} ${time}`;
}

/** Default navigation: SPA route change via History API (React Router listens to popstate). */
export function openSession(sessionId, win = window) {
  const url = `/session/${encodeURIComponent(sessionId)}`;
  if (win.location.pathname === url) return;
  win.history.pushState({}, '', url);
  win.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
}

/**
 * Render the artefact list into `container`.
 * fetchData(): Promise<{now, groups}>; extend(id, by); expire(id). Returns { destroy, refresh }.
 */
export function renderArtefacts(container, {
  fetchData, extend, expire,
  onOpenSession = (id) => openSession(id),
  openUrl = (url) => window.open(url, '_blank', 'noopener'),
  openBlank = () => window.open('', '_blank'),
  copy = (text) => navigator.clipboard.writeText(text),
  confirm = (q) => window.confirm(q),
  now = () => Date.now(),
} = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  ensureStyle(doc);
  const root = doc.createElement('div');
  root.className = 'sa-root';
  container.appendChild(root);
  let timer = null; let dead = false; let lastJson = '';

  function toast(text) {
    const t = doc.createElement('div'); t.className = 'sa-toast'; t.textContent = text;
    root.prepend(t);
    win.setTimeout(() => t.remove(), 3000);
  }

  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  async function act(fn, done) {
    try { await fn(); if (done) toast(done); } catch (err) { toast(`Failed: ${err.message || err}`); }
    lastJson = ''; refresh();
  }

  async function openItem(g, item) {
    if (!g.expired) { openUrl(item.url); return; }
    if (!confirm('Link expired: extend 24h and open?')) return;
    const w = openBlank(); // before the await, or the popup blocker eats it
    try { await extend(g.id, '24h'); } catch (err) { if (w) w.close(); toast(`Failed: ${err.message || err}`); return; }
    if (w) { w.opener = null; w.location.href = item.url; } else openUrl(item.url);
    lastJson = ''; refresh();
  }

  function button(label, act_, onClick, title) {
    const b = el('button', 'sa-btn', label);
    b.type = 'button'; b.dataset.act = act_; if (title) b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function draw(data) {
    const t = now();
    root.replaceChildren();
    if (!data.groups || data.groups.length === 0) {
      root.append(el('div', 'sa-empty', 'Nothing published yet. Ask Claude to "publish" a report, a plan or any file.'));
      return;
    }
    for (const g of data.groups) {
      const s = g.session || {};
      const status = s.status || 'ended';
      const box = el('div', `sa-group sa-s-${status}`);
      const head = el('div', 'sa-head');
      head.append(el('span', 'sa-dot'));
      const title = el('span', 'sa-title', s.title || g.sessionId.slice(0, 8));
      title.title = 'Open the session';
      title.addEventListener('click', () => onOpenSession(s.appSessionId || g.sessionId));
      head.append(title);
      if (g.separate) head.append(el('span', 'sa-tag', 'separate'));
      head.append(el('span', 'sa-badge', status));
      box.append(head);

      const sub = el('div', 'sa-sub');
      if (s.project) sub.append(el('span', 'sa-project', s.project));
      sub.append(el('span', `sa-exp${g.expired ? ' sa-gone' : ''}`, g.expired ? 'expired' : until(g.expiresAt, t)));
      box.append(sub);
      if (s.lastMessage) { const l = el('div', 'sa-last', s.lastMessage); l.title = s.lastMessage; box.append(l); }

      for (const item of g.items) {
        const row = el('button', `sa-row${g.expired ? ' sa-expired' : ''}`);
        row.type = 'button';
        row.title = item.url;
        row.append(el('span', 'sa-row-title', item.title), el('span', 'sa-age', age(t - Date.parse(item.publishedAt))));
        row.addEventListener('click', () => openItem(g, item));
        box.append(row);
      }

      const actions = el('div', 'sa-actions');
      actions.append(
        button('Copy link', 'copy', () => act(() => copy(g.url), 'Link copied'), g.url),
        button('+24h', 'extend', () => act(() => extend(g.id, '24h'), 'Extended by 24h')),
        button('Expire now', 'expire', () => act(() => expire(g.id), 'Link expired (files kept)')),
        button('Open session', 'session', () => onOpenSession(s.appSessionId || g.sessionId)),
      );
      box.append(actions);
      root.append(box);
    }
  }

  async function refresh() {
    win.clearTimeout(timer);
    if (dead) return;
    try {
      const data = await fetchData();
      if (dead) return;
      const json = JSON.stringify(data.groups);
      if (json !== lastJson) { lastJson = json; draw(data); }
    } catch (err) {
      if (dead) return;
      lastJson = '';
      root.replaceChildren(el('div', 'sa-error', `Could not load artefacts: ${err.message || err}`));
    }
    if (!dead) timer = win.setTimeout(refresh, POLL_MS);
  }

  refresh();
  return {
    refresh,
    destroy() { dead = true; win.clearTimeout(timer); root.remove(); },
  };
}

// ---- CloudCLI tab plugin contract ----
let handle = null;

export function mount(container, api) {
  handle = renderArtefacts(container, {
    fetchData: () => api.rpc('GET', 'artefacts'),
    extend: (id, by) => api.rpc('POST', 'extend', { id, by }),
    expire: (id) => api.rpc('POST', 'expire', { id }),
  });
}

export function unmount() {
  handle?.destroy();
  handle = null;
}
