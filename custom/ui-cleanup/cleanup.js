/* cloudcli-ui-cleanup: adds a Settings button next to the sidebar Refresh
   button. The new button forwards its click to the original (CSS-hidden)
   footer Settings button, so the app's own handler opens the modal.
   Failure mode if upstream markup changes: the button just doesn't appear. */
(() => {
  'use strict';
  const MARK = 'data-uic-settings';
  let scheduled = false;

  // The expanded sidebar's footer: a Discord link that is the only child of its
  // row, inside a flex-shrink-0 block that is the last child of the sidebar
  // column. (The collapsed rail also has a Discord link, but not in that shape.)
  function footerOf(doc) {
    for (const a of doc.querySelectorAll('a[href*="discord.gg"]')) {
      const rowEl = a.parentElement;
      const footer = rowEl && rowEl.parentElement;
      if (!footer || rowEl.children.length !== 1) continue;
      if (!footer.classList.contains('flex-shrink-0')) continue;
      const root = footer.parentElement;
      if (root && root.lastElementChild === footer && root.classList.contains('flex-col')) return footer;
    }
    return null;
  }

  function footerSettingsButton() {
    const footer = footerOf(document);
    const svg = footer && footer.querySelector('button svg.lucide-settings');
    return svg ? svg.closest('button') : null;
  }

  function makeButton(refreshBtn, templateSvg, label) {
    const btn = refreshBtn.cloneNode(false); // no children, no React props
    btn.setAttribute(MARK, '');
    btn.removeAttribute('disabled');
    btn.removeAttribute('id');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    const refreshSvg = refreshBtn.querySelector('svg');
    const svg = templateSvg.cloneNode(true);
    if (refreshSvg) {
      // take the header icon's size/color classes, keep the settings identity
      const cls = refreshSvg.getAttribute('class') || '';
      svg.setAttribute('class', cls.replace(/\blucide-refresh-cw\b/g, 'lucide-settings').replace(/\banimate-spin\b/g, ''));
    }
    btn.appendChild(svg);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = footerSettingsButton();
      if (target) target.click();
    });
    return btn;
  }

  // ---- Sidebar views swapped for plugin panels: Running -> session-radar, Conversations -> share-artefacts ----
  const RADAR_PLUGIN = 'session-radar';
  const ARTEFACTS_PLUGIN = 'share-artefacts';

  function authHeaders() {
    let token = null;
    try { token = localStorage.getItem('auth-token'); } catch { /* storage blocked */ }
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  const pluginModules = {}; // name -> Promise<module>
  function loadPluginModule(name) {
    if (!pluginModules[name]) {
      pluginModules[name] = fetch(`/api/plugins/${name}/assets/index.js`, { headers: authHeaders() })
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
        .then((js) => {
          const url = URL.createObjectURL(new Blob([js], { type: 'application/javascript' }));
          return import(/* @vite-ignore */ url).finally(() => URL.revokeObjectURL(url));
        })
        .catch((err) => { delete pluginModules[name]; throw err; });
    }
    return pluginModules[name];
  }

  let sessionsCache = { at: 0, promise: null };
  function fetchSessions() {
    const now = Date.now();
    if (sessionsCache.promise && now - sessionsCache.at < 2000) return sessionsCache.promise;
    const promise = fetch(`/api/plugins/${RADAR_PLUGIN}/rpc/sessions`, { headers: authHeaders() })
      .then((r) => { if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }); return r.json(); });
    sessionsCache = { at: now, promise };
    promise.catch(() => { if (sessionsCache.promise === promise) sessionsCache = { at: 0, promise: null }; });
    return promise;
  }

  async function stopSession(sessionId) {
    const r = await fetch(`/api/plugins/${RADAR_PLUGIN}/rpc/stop`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    sessionsCache = { at: 0, promise: null };
    return body;
  }

  async function artefactsRpc(method, path, body) {
    const r = await fetch(`/api/plugins/${ARTEFACTS_PLUGIN}/rpc/${path}`, {
      method,
      headers: { ...authHeaders(), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  // ---- Claude plan usage meter (claude-usage plugin) ----
  const USAGE_PLUGIN = 'claude-usage';
  const USAGE_POLL_MS = 60000;
  const METER = 'data-uic-usage';
  let usageData = null;
  let usageError = null;
  let usagePop = null; // { el, handle, onDown, onKey }

  async function fetchUsage(force) {
    const r = await fetch(`/api/plugins/${USAGE_PLUGIN}/rpc/usage${force ? '?refresh=1' : ''}`, { headers: authHeaders() });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), { status: r.status });
    return body;
  }

  async function switchUsageAccount(number) {
    const r = await fetch(`/api/plugins/${USAGE_PLUGIN}/rpc/switch`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ number }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  async function setUsageDefault(number) {
    const r = await fetch(`/api/plugins/${USAGE_PLUGIN}/rpc/default`, {
      method: 'PUT',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ defaultAccount: number }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  function meterLevel(pct) { return pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok'; }

  function paintMeter(m) {
    if (!usageData) {
      m.dataset.level = usageError ? 'err' : 'ok';
      m.textContent = usageError ? 'usage ?' : 'usage …';
      m.title = usageError ? `Usage unavailable: ${usageError}` : 'Loading Claude usage…';
      return;
    }
    const a = (usageData.accounts || []).find((x) => x.active) || (usageData.accounts || [])[0];
    if (!a) { m.textContent = 'usage –'; return; }
    const five = a.fiveHour && a.fiveHour.pct != null ? Math.round(a.fiveHour.pct) : null;
    const seven = a.sevenDay && a.sevenDay.pct != null ? Math.round(a.sevenDay.pct) : null;
    const scoped = (a.scoped || []).filter((x) => x.pct != null);
    const worst = Math.max(five || 0, seven || 0, ...scoped.map((x) => x.pct));
    m.dataset.level = meterLevel(worst);
    const maxed = scoped.filter((x) => x.pct >= 100).length;
    const full = `5h ${five ?? '–'}%`;
    const rest = ` · 7d ${seven ?? '–'}%${maxed ? ' !' : ''}`;
    const tail = document.createElement('span');
    tail.className = 'uic-usage-7d';
    tail.textContent = rest;
    m.replaceChildren(full, tail);
    if (maxed) m.dataset.maxed = '1'; else delete m.dataset.maxed;
    m.title = [`#${a.number} ${a.email || ''}`,
      `5-hour: ${five ?? '–'}%${a.fiveHour && a.fiveHour.countdown ? ` (resets in ${a.fiveHour.countdown})` : ''}`,
      `7-day: ${seven ?? '–'}%${a.sevenDay && a.sevenDay.countdown ? ` (resets in ${a.sevenDay.countdown})` : ''}`,
      ...scoped.map((x) => `7-day ${x.name}: ${Math.round(x.pct)}%`),
      ...codexTitleLines(),
      'Click for all accounts'].join('\n');
  }

  // Codex usage (from its local session logs) is only present on machines that use Codex.
  function codexTitleLines() {
    const cx = usageData && usageData.codex && (usageData.codex.limits || []).find((l) => l.id === 'codex');
    if (!cx) return [];
    const pct = (w) => (w && w.pct != null ? `${Math.round(w.pct)}%` : '–');
    return [`Codex: 5h ${pct(cx.primary)} · 7d ${pct(cx.secondary)} (as of last Codex request)`];
  }

  // Show only the 5h figure when the row holding the meter has no room for the full text.
  function fitMeter(m) {
    if (!m.isConnected) return;
    delete m.dataset.compact;
    const row = m.getAttribute(METER) === 'composer' ? m.parentElement : m.parentElement && m.parentElement.parentElement;
    if (row && row.scrollWidth > row.clientWidth + 1) m.dataset.compact = '1';
  }

  function paintAllMeters() {
    document.querySelectorAll(`[${METER}]`).forEach((m) => { paintMeter(m); fitMeter(m); });
  }

  window.addEventListener('resize', () => document.querySelectorAll(`[${METER}]`).forEach(fitMeter));
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => document.querySelectorAll(`[${METER}]`).forEach(fitMeter));
    const watch = () => document.querySelectorAll(`[${METER}]`).forEach((m) => {
      const row = m.parentElement && (m.getAttribute(METER) === 'composer' ? m.parentElement : m.parentElement.parentElement);
      if (row && !row.__uicRo) { row.__uicRo = true; ro.observe(row); }
    });
    setInterval(watch, 2000);
  }

  async function pollUsage() {
    try {
      let token = null;
      try { token = localStorage.getItem('auth-token'); } catch { /* ignore */ }
      if (token) { usageData = await fetchUsage(false); usageError = null; }
    } catch (err) {
      usageError = err.message || String(err);
    } finally {
      paintAllMeters();
      setTimeout(pollUsage, USAGE_POLL_MS);
    }
  }

  function closeUsagePop() {
    if (!usagePop) return;
    try { usagePop.handle && usagePop.handle.destroy(); } catch { /* ignore */ }
    usagePop.el.remove();
    document.removeEventListener('mousedown', usagePop.onDown, true);
    document.removeEventListener('keydown', usagePop.onKey, true);
    usagePop = null;
  }

  function openUsagePop(anchor) {
    if (usagePop) { closeUsagePop(); return; }
    const el = document.createElement('div');
    el.id = 'uic-usage-pop';
    const r = anchor.getBoundingClientRect();
    if (r.top > innerHeight / 2) {
      el.style.bottom = `${Math.round(innerHeight - r.top + 6)}px`;
      el.style.maxHeight = `${Math.round(r.top - 14)}px`;
    } else {
      el.style.top = `${Math.round(r.bottom + 6)}px`;
    }
    el.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - 348)))}px`;
    document.body.appendChild(el);
    const pop = { el, handle: null };
    pop.onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeUsagePop(); };
    pop.onKey = (e) => { if (e.key === 'Escape') closeUsagePop(); };
    document.addEventListener('mousedown', pop.onDown, true);
    document.addEventListener('keydown', pop.onKey, true);
    usagePop = pop;
    loadPluginModule(USAGE_PLUGIN)
      .then((mod) => {
        if (usagePop !== pop) return;
        pop.handle = mod.renderUsage(el, {
          fetchData: async (force) => { const d = await fetchUsage(force); usageData = d; usageError = null; paintAllMeters(); return d; },
          switchAccount: switchUsageAccount,
          setDefault: setUsageDefault,
          onData: (d) => { usageData = d; usageError = null; paintAllMeters(); },
        });
      })
      .catch((err) => { el.textContent = `Usage plugin unavailable: ${err.message || err}`; });
  }

  function makeMeter(variant) {
    const m = document.createElement('button');
    m.type = 'button';
    m.setAttribute(METER, variant);
    m.className = `uic-usage-meter uic-usage-meter--${variant}`;
    m.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openUsagePop(m); });
    paintMeter(m);
    requestAnimationFrame(() => fitMeter(m));
    return m;
  }

  // Sidebar header: just before our Settings button.
  function ensureMeter(settingsBtn) {
    const prev = settingsBtn.previousElementSibling;
    if (prev && prev.hasAttribute(METER)) return;
    settingsBtn.before(makeMeter('header'));
  }

  // Chat composer: right after "Show all commands" (speech-bubble icon) in the
  // toolbar that also holds the attach (paperclip) button.
  function ensureComposerMeters() {
    document.querySelectorAll('button svg.lucide-paperclip').forEach((clip) => {
      const tools = clip.closest('button') && clip.closest('button').parentElement;
      if (!tools) return;
      const cmdSvg = [...tools.querySelectorAll(':scope > button svg.lucide-message-square')][0];
      const cmdBtn = cmdSvg && cmdSvg.closest('button');
      if (!cmdBtn || cmdBtn.parentElement !== tools) return;
      const next = cmdBtn.nextElementSibling;
      if (next && next.hasAttribute(METER)) return;
      cmdBtn.after(makeMeter('composer'));
    });
  }

  // ---- Needs-input alert: pulsing favicon + pulsing badge that jumps to the conversation ----
  const ALERT_POLL_MS = 5000;
  const PULSE_MS = 700;
  let pulseTimer = null;
  let pulseOn = false;
  let origIcons = null; // [{ link, href }]
  let iconFrames = null; // Promise<[litHref, dimHref]>
  let alertBadge = null;
  let waitingNow = [];
  // Inside env-switcher's iframe only the top window's favicon is visible, so the top one pulses
  // for everyone: it adds the other environments' count, published by env-switcher.
  const FRAMED = (() => { try { return window.top !== window.self; } catch { return true; } })();
  const remoteWaiting = () => Number(document.documentElement.dataset.envswWaiting) || 0;
  const shouldPulse = () => !FRAMED && waitingNow.length + remoteWaiting() > 0;

  function sessionPath(s) { return `/session/${encodeURIComponent(s.appSessionId || s.sessionId)}`; }

  function goTo(s) {
    const url = sessionPath(s);
    if (location.pathname === url) return;
    history.pushState({}, '', url);
    dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }

  function buildIconFrames() {
    if (iconFrames) return iconFrames;
    iconFrames = new Promise((resolve) => {
      const img = new Image();
      const draw = (withBase) => {
        const frame = (lit) => {
          const c = document.createElement('canvas');
          c.width = c.height = 64;
          const g = c.getContext('2d');
          if (withBase) g.drawImage(img, 0, 0, 64, 64);
          g.beginPath();
          g.arc(46, 46, lit ? 17 : 13, 0, Math.PI * 2);
          g.fillStyle = lit ? '#f59e0b' : 'rgba(245,158,11,.35)';
          g.fill();
          if (lit) { g.lineWidth = 4; g.strokeStyle = '#ffffff'; g.stroke(); }
          return c.toDataURL('image/png');
        };
        resolve([frame(true), frame(false)]);
      };
      img.onload = () => draw(true);
      img.onerror = () => draw(false);
      img.src = '/favicon.png';
    });
    return iconFrames;
  }

  function iconLinks() {
    let links = [...document.querySelectorAll('link[rel~="icon"]')];
    if (links.length === 0) {
      const l = document.createElement('link');
      l.rel = 'icon';
      document.head.appendChild(l);
      links = [l];
    }
    return links;
  }

  function startPulse() {
    if (pulseTimer) return;
    buildIconFrames().then(([lit, dim]) => {
      if (pulseTimer || !shouldPulse()) return;
      origIcons = iconLinks().map((link) => ({ link, href: link.getAttribute('href'), type: link.getAttribute('type') }));
      const tick = () => {
        pulseOn = !pulseOn;
        for (const { link } of origIcons) { link.setAttribute('type', 'image/png'); link.setAttribute('href', pulseOn ? lit : dim); }
      };
      tick();
      pulseTimer = setInterval(tick, PULSE_MS);
    });
  }

  function stopPulse() {
    if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
    if (origIcons) {
      for (const { link, href, type } of origIcons) {
        if (href === null) link.removeAttribute('href'); else link.setAttribute('href', href);
        if (type === null) link.removeAttribute('type'); else link.setAttribute('type', type);
      }
      origIcons = null;
    }
  }

  function currentPath() { return location.pathname; }

  function renderBadge() {
    // targets = waiting sessions other than the one already open
    const targets = waitingNow.filter((s) => sessionPath(s) !== currentPath());
    if (targets.length === 0) {
      if (alertBadge) { alertBadge.remove(); alertBadge = null; }
      return;
    }
    if (!alertBadge || !alertBadge.isConnected) {
      alertBadge = document.createElement('button');
      alertBadge.type = 'button';
      alertBadge.id = 'uic-alert';
      alertBadge.addEventListener('click', (e) => {
        e.preventDefault();
        const next = waitingNow.find((s) => sessionPath(s) !== currentPath());
        if (next) goTo(next);
        renderBadge();
      });
      document.body.appendChild(alertBadge);
    }
    const first = targets[0];
    const more = targets.length > 1 ? ` +${targets.length - 1}` : '';
    const label = `${first.title}${first.project ? ` · ${first.project}` : ''}`;
    alertBadge.title = `Needs your input: ${label}\nClick to open`;
    alertBadge.innerHTML = '';
    const dot = document.createElement('span'); dot.className = 'uic-alert-dot';
    const text = document.createElement('span'); text.className = 'uic-alert-text';
    text.textContent = `Needs input: ${first.title}`;
    const count = document.createElement('span'); count.className = 'uic-alert-more'; count.textContent = more;
    alertBadge.append(dot, text, count);
  }

  function syncPulse() { if (shouldPulse()) startPulse(); else stopPulse(); }

  function updateAlert(sessions) {
    waitingNow = sessions.filter((s) => s.state === 'waiting');
    const count = String(waitingNow.length);
    if (document.documentElement.dataset.uicWaiting !== count) {
      document.documentElement.dataset.uicWaiting = count; // read by env-switcher if it loads later
      dispatchEvent(new CustomEvent('uic:waiting', { detail: { count: waitingNow.length } }));
    }
    syncPulse();
    renderBadge();
  }
  addEventListener('envsw:waiting', syncPulse);

  async function pollAlert() {
    let delay = ALERT_POLL_MS;
    try {
      let token = null;
      try { token = localStorage.getItem('auth-token'); } catch { /* ignore */ }
      if (token) updateAlert((await fetchSessions()).sessions || []);
    } catch (err) {
      if (err && err.status === 404) delay = 60000; // plugin not installed/running
      updateAlert([]);
    } finally {
      setTimeout(pollAlert, delay);
    }
  }
  addEventListener('popstate', () => setTimeout(renderBadge, 0));

  // The list between header and footer (the only flex-1 child) is hidden while a mode tab with a
  // plugin panel is pressed, and the panel is mounted in its place.
  const PANELS = [
    { attr: 'data-uic-radar', icon: 'lucide-activity', plugin: RADAR_PLUGIN, name: 'Sessions',
      render: (mod, el) => mod.renderRadar(el, { fetchData: fetchSessions, stopSession }) },
    { attr: 'data-uic-artefacts', icon: 'lucide-message-square', plugin: ARTEFACTS_PLUGIN, name: 'Artefacts',
      render: (mod, el) => mod.renderArtefacts(el, {
        fetchData: () => artefactsRpc('GET', 'artefacts'),
        extend: (id, by) => artefactsRpc('POST', 'extend', { id, by }),
        expire: (id) => artefactsRpc('POST', 'expire', { id }),
        onOpenSession: (id) => goTo({ sessionId: id }),
      }) },
  ];
  const panels = new Map(); // attr -> { el, handle }

  function syncPanels(root, header) {
    const list = [...root.children].find((el) => el !== header && el.classList.contains('flex-1')
      && !PANELS.some((p) => el.hasAttribute(p.attr)));
    if (!list) return;
    const active = PANELS.find((p) => header.querySelector(`button[aria-pressed="true"] svg.${p.icon}`));
    for (const p of PANELS) {
      const cur = panels.get(p.attr);
      if (p === active) {
        if (cur && cur.el.isConnected) continue;
        const entry = { el: document.createElement('div'), handle: null };
        entry.el.setAttribute(p.attr, '');
        entry.el.className = 'flex-1 overflow-y-auto overscroll-contain';
        list.before(entry.el);
        panels.set(p.attr, entry);
        loadPluginModule(p.plugin)
          .then((mod) => {
            if (panels.get(p.attr) !== entry || !entry.el.isConnected) return;
            entry.handle = p.render(mod, entry.el);
            schedule(); // apply the search box's current text to the new panel
          })
          .catch((err) => { entry.el.textContent = `${p.name} plugin unavailable: ${err.message || err}`; entry.el.style.padding = '16px'; });
      } else if (cur) {
        try { cur.handle && cur.handle.destroy(); } catch { /* ignore */ }
        cur.el.remove();
        panels.delete(p.attr);
      }
    }
    if (active) list.setAttribute('data-uic-hidden', '');
    else list.removeAttribute('data-uic-hidden');
    syncArtefactsSearch(header);
  }

  // On the Artefacts tab the sidebar search box filters the artefacts. Typing does not touch the
  // DOM, so an input listener applies it at once; the sync on every apply() covers the clear button.
  const ARTEFACTS_PLACEHOLDER = 'Search artefacts...';
  function syncArtefactsSearch(header) {
    const entry = panels.get('data-uic-artefacts');
    if (!entry) return;
    header.querySelectorAll('input.nav-search-input').forEach((input) => {
      if (input.placeholder !== ARTEFACTS_PLACEHOLDER) input.placeholder = ARTEFACTS_PLACEHOLDER;
      if (input.offsetParent !== null && entry.handle && entry.handle.setFilter) entry.handle.setFilter(input.value);
    });
  }
  document.addEventListener('input', (e) => {
    const entry = panels.get('data-uic-artefacts');
    if (entry && entry.handle && entry.handle.setFilter && e.target.matches && e.target.matches('input.nav-search-input')) {
      entry.handle.setFilter(e.target.value);
    }
  }, true);

  // The Conversations mode tab shows the Artefacts list (see PANELS), so it says so.
  function relabelConversations(header) {
    header.querySelectorAll('button svg.lucide-message-square').forEach((svg) => {
      const label = svg.closest('button').querySelector('span.truncate');
      if (label && label.textContent !== 'Artefacts') label.textContent = 'Artefacts';
    });
  }

  // ---- Workspace tabs hidden by cleanup.css (Usage, Sessions) ----
  // CSS hides them; the tab bar's arrow keys .click() every [role=tab] button
  // though, so disable them too, and leave one if it was the open tab (a
  // restored last tab, or a link) for Chat.
  const HIDDEN_TABS = ['Usage', 'Sessions', 'Artefacts', 'Project Stats'];

  function hideWorkspaceTabs() {
    document.querySelectorAll('[role="tablist"] [role="tab"]').forEach((tab) => {
      if (!HIDDEN_TABS.includes(tab.getAttribute('aria-label'))) return;
      if (!tab.disabled) tab.disabled = true;
      if (tab.getAttribute('aria-selected') === 'true') {
        const first = tab.closest('[role="tablist"]').querySelector('[role="tab"]:not(:disabled)');
        if (first) first.click();
      }
    });
  }

  function apply() {
    scheduled = false;
    try { hideWorkspaceTabs(); } catch (err) { console.warn('[ui-cleanup] workspace tabs', err); }
    try { ensureComposerMeters(); } catch (err) { console.warn('[ui-cleanup] composer meter', err); }
    try {
      const footer = footerOf(document);
      const root = footer && footer.parentElement;
      const header = root && root.firstElementChild;
      if (!header || header === footer) return;
      try { syncPanels(root, header); } catch (err) { console.warn('[ui-cleanup] sidebar panels', err); }
      try { relabelConversations(header); } catch (err) { console.warn('[ui-cleanup] artefacts label', err); }
      const settingsBtn = footerSettingsButton();
      const templateSvg = settingsBtn && settingsBtn.querySelector('svg');
      if (!templateSvg) return;
      const label = (settingsBtn.textContent || '').trim() || 'Settings';
      header.querySelectorAll('svg.lucide-refresh-cw').forEach((svg) => {
        const refreshBtn = svg.closest('button');
        if (!refreshBtn || !refreshBtn.parentElement) return;
        const prev = refreshBtn.previousElementSibling;
        if (prev && prev.hasAttribute(MARK)) return;
        refreshBtn.before(makeButton(refreshBtn, templateSvg, label));
      });
      header.querySelectorAll('[data-uic-settings]').forEach((b) => ensureMeter(b));
    } catch (err) {
      console.warn('[ui-cleanup]', err);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(apply, 16); // not rAF: rAF pauses in background tabs
  }

  // ---- Terminal font (web-terminal plugin): MesloLGS NF for Powerlevel10k ----
  const TERM_PREFS_KEY = 'web-terminal-prefs';
  const NERD_FONT = '"MesloLGS NF"';
  const TERM_FALLBACK = 'Menlo, Monaco, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace';

  // Runs before the plugin mounts: it reads these prefs when it creates a terminal.
  function migrateTerminalPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem(TERM_PREFS_KEY) || '{}') || {};
      let changed = false;
      if (typeof prefs.fontFamily !== 'string' || !prefs.fontFamily.includes('MesloLGS NF')) {
        prefs.fontFamily = `${NERD_FONT}, ${TERM_FALLBACK}`;
        changed = true;
      }
      if (localStorage.getItem('uic-term-compact-v1') !== '1') { // once; the gear menu wins afterwards
        prefs.fontSize = 12;
        localStorage.setItem('uic-term-compact-v1', '1');
        changed = true;
      }
      if (changed) localStorage.setItem(TERM_PREFS_KEY, JSON.stringify(prefs));
    } catch { /* storage blocked */ }
  }

  // xterm measures the cell size once, when the terminal is created. If that
  // happened before the web font arrived, nudge the size -1/+1 through the
  // plugin's own controls so it re-measures with the real font.
  function remeasureTerminals() {
    const btn = (label) => document.querySelector(`.wt-fs-row button[aria-label="${label}"], .wt-fs-row button[title="${label}"]`);
    const minus = btn('Decrease font size');
    const plus = btn('Increase font size');
    if (minus && plus && document.querySelector('.wt-root .xterm')) { minus.click(); plus.click(); }
  }

  function loadTerminalFont() {
    if (!document.fonts || !document.fonts.load) return;
    const terminalExisted = () => !!document.querySelector('.wt-root .xterm');
    const before = terminalExisted();
    Promise.all([document.fonts.load(`12px ${NERD_FONT}`), document.fonts.load(`bold 12px ${NERD_FONT}`)])
      .then(() => { if (before || terminalExisted()) remeasureTerminals(); })
      .catch(() => { /* font unavailable: fallback stack is used */ });
  }

  function start() {
    migrateTerminalPrefs();
    loadTerminalFont();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
    pollAlert();
    pollUsage();
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
