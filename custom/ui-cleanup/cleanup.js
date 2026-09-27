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

  // ---- Running view -> session-radar list ----
  const RADAR_PLUGIN = 'session-radar';
  let radarModule = null; // Promise<module>
  let radarHandle = null;
  let radarPanel = null;

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
  const loadRadar = () => loadPluginModule(RADAR_PLUGIN);

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
    m.textContent = `5h ${five ?? '–'}% · 7d ${seven ?? '–'}%${maxed ? ' !' : ''}`;
    m.title = [`#${a.number} ${a.email || ''}`,
      `5-hour: ${five ?? '–'}%${a.fiveHour && a.fiveHour.countdown ? ` (resets in ${a.fiveHour.countdown})` : ''}`,
      `7-day: ${seven ?? '–'}%${a.sevenDay && a.sevenDay.countdown ? ` (resets in ${a.sevenDay.countdown})` : ''}`,
      ...scoped.map((x) => `7-day ${x.name}: ${Math.round(x.pct)}%`),
      'Click for all accounts'].join('\n');
  }

  function paintAllMeters() { document.querySelectorAll(`[${METER}]`).forEach(paintMeter); }

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
      if (pulseTimer || waitingNow.length === 0) return;
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

  function updateAlert(sessions) {
    waitingNow = sessions.filter((s) => s.state === 'waiting');
    if (waitingNow.length > 0) startPulse(); else stopPulse();
    renderBadge();
  }

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

  function syncRunningView(root, header) {
    const runningActive = !!header.querySelector('button[aria-pressed="true"] svg.lucide-activity');
    // the project/session list between header and footer (the only flex-1 child)
    const list = [...root.children].find((el) => el !== header && el !== radarPanel
      && !el.hasAttribute('data-uic-radar') && el.classList.contains('flex-1'));
    if (!list) return;
    if (runningActive) {
      list.setAttribute('data-uic-hidden', '');
      if (!radarPanel || !radarPanel.isConnected) {
        radarPanel = document.createElement('div');
        radarPanel.setAttribute('data-uic-radar', '');
        radarPanel.className = 'flex-1 overflow-y-auto overscroll-contain';
        list.before(radarPanel);
        const panel = radarPanel;
        loadRadar()
          .then((mod) => {
            if (panel !== radarPanel || !panel.isConnected) return;
            radarHandle = mod.renderRadar(panel, { fetchData: fetchSessions });
          })
          .catch((err) => { panel.textContent = `Sessions plugin unavailable: ${err.message || err}`; panel.style.padding = '16px'; });
      }
    } else {
      list.removeAttribute('data-uic-hidden');
      if (radarPanel) {
        try { radarHandle && radarHandle.destroy(); } catch { /* ignore */ }
        radarHandle = null;
        radarPanel.remove();
        radarPanel = null;
      }
    }
  }

  function apply() {
    scheduled = false;
    try { ensureComposerMeters(); } catch (err) { console.warn('[ui-cleanup] composer meter', err); }
    try {
      const footer = footerOf(document);
      const root = footer && footer.parentElement;
      const header = root && root.firstElementChild;
      if (!header || header === footer) return;
      try { syncRunningView(root, header); } catch (err) { console.warn('[ui-cleanup] running view', err); }
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
