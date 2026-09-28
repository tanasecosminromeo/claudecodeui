/* env-switcher: click the sidebar logo to switch between CloudCLI instances (e.g. two machines
   behind one Cloudflare Access app). The window you opened is "home"; the others load into
   full-screen iframes on first use and stay alive, so switching never reloads them.
   Config: <script id="envsw-config"> written by ui-cleanup/inject-html.mjs from ENV_SWITCHER.
   The same file runs in three modes:
   - host: the top window. Renders the menu and owns the iframes.
   - embedded: inside a host's iframe. Forwards logo clicks and status to the host via postMessage.
   - auth landing: a top-level `?envsw=auth` page, opened only to pass Cloudflare Access (whose
     login page refuses to be framed). Reports back, then closes or returns to the host.
   Failure mode if upstream markup changes: the logo chip doesn't appear; the app is unaffected. */
(() => {
  'use strict';

  const PROBE_MS = 60000;
  const HELLO_GRACE_MS = 1500; // after the iframe's load event
  const HELLO_HARD_MS = 20000; // no load event at all
  const RETRY_MIN_MS = 5000;
  const STORE_KEY = 'envsw:v1';
  const MSG_TYPES = new Set([
    'envsw:hello', 'envsw:open-menu', 'envsw:title', 'envsw:path', 'envsw:waiting', 'envsw:probe',
    'envsw:activate-me', 'envsw:switch', 'envsw:authed', 'envsw:init', 'envsw:peers', 'envsw:reprobe',
  ]);
  const PROBE_STATES = new Set(['ok', 'auth', 'down', 'offline']);

  // ---- Pure helpers ----

  function parseConfig(text) {
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data && data.envs) ? data.envs : [];
      return list
        .filter((e) => e && typeof e.name === 'string' && typeof e.origin === 'string')
        .map((e, index) => ({ id: `env${index}`, index, name: e.name, origin: e.origin, host: hostOf(e.origin) }));
    } catch {
      return [];
    }
  }

  function hostOf(origin) {
    try { return new URL(origin).host; } catch { return origin; }
  }

  // In-app paths only: "/x" yes, "//evil.example" and "https://…" no.
  function safePath(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
    return value;
  }

  // Result of a same-origin fetch('/api/auth/status', { redirect: 'manual' }) through Cloudflare.
  function classifyProbe(res) {
    if (!res) return 'offline';
    if (res.type === 'opaqueredirect') return 'auth'; // Access wants to send us to its login page
    if (res.status === 502 || res.status === 503 || res.status === 504 || (res.status >= 520 && res.status <= 530)) return 'down';
    return 'ok';
  }

  const clampCount = (n) => Math.max(0, Math.min(99, Math.trunc(Number(n)) || 0));

  function validateMessage(data) {
    if (!data || typeof data !== 'object' || typeof data.type !== 'string' || !MSG_TYPES.has(data.type)) return null;
    const msg = { type: data.type };
    switch (data.type) {
      case 'envsw:open-menu': {
        const r = data.rect || {};
        const rect = { left: Number(r.left), top: Number(r.top), right: Number(r.right), bottom: Number(r.bottom) };
        if (!Object.values(rect).every(Number.isFinite)) return null;
        msg.rect = rect;
        break;
      }
      case 'envsw:title':
        msg.title = typeof data.title === 'string' ? data.title.slice(0, 200) : '';
        break;
      case 'envsw:path':
        msg.path = safePath(data.path);
        if (!msg.path) return null;
        break;
      case 'envsw:waiting':
      case 'envsw:peers':
        msg.count = clampCount(data.count);
        break;
      case 'envsw:probe':
        if (!PROBE_STATES.has(data.state)) return null;
        msg.state = data.state;
        break;
      case 'envsw:switch': {
        const index = Math.trunc(Number(data.index));
        if (!(index >= 0 && index < 9)) return null;
        msg.index = index;
        break;
      }
      default:
        break;
    }
    return msg;
  }

  // ?return= must be exactly another configured origin, or the auth landing is an open redirect.
  function returnOrigin(envs, value, selfOrigin) {
    const env = envs.find((e) => e.origin === value);
    return env && env.origin !== selfOrigin ? env.origin : null;
  }

  // Ctrl+Option+1..9 (e.code, so macOS Option characters don't matter) -> 0..8
  function shortcutIndex(e) {
    if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return null;
    const m = /^Digit([1-9])$/.exec(e.code || '');
    return m ? Number(m[1]) - 1 : null;
  }

  function frameUrl(env, path) { return env.origin + (safePath(path) || '/'); }

  function isFramed() {
    try { return window.top !== window.self; } catch { return true; }
  }

  // ---- Shared DOM plumbing ----

  function make(tag, className, attrs) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }

  function whenReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  // LogoBlock (src/modules/sidebar/SidebarHeader.tsx): div.min-w-0 > [div > svg, h1]; rendered for
  // the desktop header and the mobile drawer. Attributes only, no child nodes: React owns the children.
  function logoRoots() {
    const roots = [];
    for (const h1 of document.querySelectorAll('h1')) {
      const root = h1.parentElement;
      if (!root || !root.classList.contains('min-w-0') || root.lastElementChild !== h1) continue;
      const mark = root.firstElementChild;
      if (!mark || mark === h1 || !mark.querySelector('svg')) continue;
      roots.push(root);
    }
    return roots;
  }

  function markLogos(label, alert) {
    for (const root of logoRoots()) {
      if (!root.hasAttribute('data-envsw-logo')) {
        root.setAttribute('data-envsw-logo', '');
        root.setAttribute('role', 'button');
        root.setAttribute('tabindex', '0');
        root.setAttribute('aria-haspopup', 'menu');
        root.setAttribute('title', 'Switch environment (Ctrl+Option+1…9)');
      }
      if (root.getAttribute('data-envsw-label') !== label) root.setAttribute('data-envsw-label', label);
      root.toggleAttribute('data-envsw-alert', !!alert);
    }
  }

  // Everything a mode needs to tear down (tests start several modes in one document).
  function lifecycle() {
    const ac = new AbortController();
    const observers = [];
    const timers = new Set();
    return {
      signal: ac.signal,
      observe(target, fn, options) {
        const mo = new MutationObserver(fn);
        mo.observe(target, options);
        observers.push(mo);
      },
      later(fn, ms) {
        const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
        timers.add(t);
        return t;
      },
      cancel(t) { clearTimeout(t); timers.delete(t); },
      destroy() {
        ac.abort();
        observers.forEach((mo) => mo.disconnect());
        timers.forEach(clearTimeout);
        timers.clear();
      },
    };
  }

  // Logo click/Enter and the Ctrl+Option+digit shortcut, in the capture phase so the app never sees them
  // (and an IS_PLATFORM build's <a href> wrapper doesn't navigate).
  function bindLogoInput(life, onLogo, onShortcut) {
    const { signal } = life;
    document.addEventListener('click', (e) => {
      const root = e.target instanceof Element ? e.target.closest('[data-envsw-logo]') : null;
      if (!root) return;
      e.preventDefault();
      e.stopPropagation();
      onLogo(root.getBoundingClientRect());
    }, { capture: true, signal });
    document.addEventListener('keydown', (e) => {
      const index = shortcutIndex(e);
      if (index !== null) {
        e.preventDefault();
        e.stopPropagation();
        onShortcut(index);
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.matches('[data-envsw-logo]')) {
        e.preventDefault();
        onLogo(e.target.getBoundingClientRect());
      }
    }, { capture: true, signal });
  }

  function watchLogos(life, paint) {
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      life.later(() => { queued = false; paint(); }, 50);
    };
    life.observe(document.body, schedule, { childList: true, subtree: true });
    paint();
  }

  async function probe() {
    if (navigator.onLine === false) return 'offline';
    try {
      const res = await fetch('/api/auth/status', { redirect: 'manual', cache: 'no-store', credentials: 'same-origin' });
      return classifyProbe(res);
    } catch {
      return 'offline';
    }
  }

  function startProbeLoop(life, onState) {
    let last = null;
    let running = false;
    const run = async () => {
      if (running || life.signal.aborted) return;
      running = true;
      try {
        const state = await probe();
        if (!life.signal.aborted && state !== last) { last = state; onState(state); }
      } finally {
        running = false;
      }
    };
    const loop = () => {
      if (document.visibilityState !== 'hidden') run();
      life.later(loop, PROBE_MS);
    };
    for (const type of ['focus', 'online']) addEventListener(type, run, { signal: life.signal });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); }, { signal: life.signal });
    life.later(loop, PROBE_MS);
    return { run, get last() { return last; }, reset() { last = null; } };
  }

  function localWaiting() { return Number(document.documentElement.dataset.uicWaiting) || 0; }

  // ---- Auth landing: top-level ?envsw=auth ----

  // Returns true when this page is navigating away (the round trip back to the host).
  function handleAuthLanding(envs, self, params) {
    const back = returnOrigin(envs, params.get('return'), location.origin);
    try {
      const url = new URL(location.href);
      url.searchParams.delete('envsw');
      url.searchParams.delete('return');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    } catch { /* ignore */ }
    if (back) {
      location.replace(`${back}/`);
      return true;
    }
    if (window.opener) {
      for (const env of envs) {
        if (env === self) continue;
        try { window.opener.postMessage({ type: 'envsw:authed' }, env.origin); } catch { /* ignore */ }
      }
      setTimeout(() => { try { window.close(); } catch { /* ignore */ } }, 100);
    }
    // Still open after that (the login redirects cut the opener link, or close() was refused).
    setTimeout(() => whenReady(() => showBanner(`Signed in to ${self ? self.name : location.host}. You can close this window.`, null)), 700);
    return false;
  }

  let bannerEl = null;
  function showBanner(text, action) {
    if (!bannerEl || !bannerEl.isConnected) {
      bannerEl = make('div', '', { id: 'envsw-banner', 'data-envsw': '', role: 'status' });
      document.body.appendChild(bannerEl);
    }
    bannerEl.textContent = '';
    bannerEl.append(make('span', 'envsw-banner-text'));
    bannerEl.firstChild.textContent = text;
    if (action) {
      const btn = make('button', 'envsw-btn envsw-btn-primary', { type: 'button' });
      btn.textContent = action.label;
      btn.addEventListener('click', action.run);
      bannerEl.append(btn);
    }
    const close = make('button', 'envsw-btn', { type: 'button', 'aria-label': 'Dismiss' });
    close.textContent = '×';
    close.addEventListener('click', hideBanner);
    bannerEl.append(close);
  }
  function hideBanner() { if (bannerEl) { bannerEl.remove(); bannerEl = null; } }

  // ---- Embedded mode ----

  function startEmbedded(envs, self) {
    const life = lifecycle();
    const { signal } = life;
    let hostOrigin = null;
    let peersWaiting = 0;
    let lastTitle = null;
    let lastPath = null;

    // Before the host's init we don't know its origin (Firefox has no ancestorOrigins, and the
    // referrer is lost across Access redirects): post to every configured origin and let
    // targetOrigin drop the wrong ones.
    const post = (msg) => {
      const targets = hostOrigin ? [hostOrigin] : envs.filter((e) => e !== self).map((e) => e.origin);
      for (const origin of targets) {
        try { window.parent.postMessage(msg, origin); } catch { /* ignore */ }
      }
    };

    const sendTitle = (force) => {
      const title = document.title.slice(0, 200);
      if (force || title !== lastTitle) { lastTitle = title; post({ type: 'envsw:title', title }); }
    };
    const sendPath = (force) => {
      const path = location.pathname + location.search;
      if (safePath(path) && (force || path !== lastPath)) { lastPath = path; post({ type: 'envsw:path', path }); }
    };
    const sendWaiting = () => post({ type: 'envsw:waiting', count: localWaiting() });

    post({ type: 'envsw:hello' }); // as early as possible: the host treats silence after load as "blocked"

    // The iframe shares the tab's session history with the host, so an in-app pushState would make
    // the Back button silently move a hidden frame. Replace instead, and report the path.
    const origReplace = history.replaceState.bind(history);
    history.pushState = (state, unused, url) => { origReplace(state, unused, url); sendPath(); };
    history.replaceState = (state, unused, url) => { origReplace(state, unused, url); sendPath(); };
    signal.addEventListener('abort', () => { delete history.pushState; delete history.replaceState; });
    addEventListener('popstate', () => sendPath(), { signal });

    addEventListener('message', (e) => {
      if (e.source !== window.parent || !envs.some((env) => env.origin === e.origin && env !== self)) return;
      const msg = validateMessage(e.data);
      if (!msg) return;
      if (msg.type === 'envsw:init') {
        hostOrigin = e.origin;
        sendTitle(true);
        sendPath(true);
        sendWaiting();
        if (probes.last) post({ type: 'envsw:probe', state: probes.last });
      } else if (msg.type === 'envsw:peers') {
        peersWaiting = msg.count;
        markLogos(self.name, peersWaiting > 0);
      } else if (msg.type === 'envsw:reprobe') {
        probes.reset();
        probes.run();
      }
    }, { signal });

    addEventListener('uic:waiting', sendWaiting, { signal });
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'notification:navigate') post({ type: 'envsw:activate-me' });
      }, { signal });
    }
    const probes = startProbeLoop(life, (state) => post({ type: 'envsw:probe', state }));

    whenReady(() => {
      bindLogoInput(
        life,
        (rect) => post({ type: 'envsw:open-menu', rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } }),
        (index) => post({ type: 'envsw:switch', index }),
      );
      watchLogos(life, () => markLogos(self.name, peersWaiting > 0));
      life.observe(document.head, () => sendTitle(false), { childList: true, subtree: true, characterData: true });
      sendTitle(true);
      sendPath(true);
      probes.run();
    });

    return { mode: 'embedded', post, destroy: life.destroy };
  }

  // ---- Host mode ----

  function startHost(envs, self) {
    const life = lifecycle();
    const { signal } = life;
    // Iframes only when this page is itself one of the configured origins (same site as the others,
    // so Access cookies flow). Otherwise, e.g. opened as http://127.0.0.1:8022, entries open new tabs.
    const remotes = self ? envs.filter((e) => e !== self) : [];
    const frames = new Map(); // env.id -> frame state
    const store = loadStore();
    let active = null; // env.id of the visible remote, null = home
    let stage = null;
    let menu = null; // { backdrop, box }
    let homeTitle = document.title;
    let writtenTitle = null;
    let authAttemptAt = 0;
    let popup = null;
    const inerted = new Set();

    function loadStore() {
      try {
        const s = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}') || {};
        return { active: typeof s.active === 'string' ? s.active : null, paths: s.paths && typeof s.paths === 'object' ? s.paths : {} };
      } catch {
        return { active: null, paths: {} };
      }
    }
    function saveStore() {
      const paths = { ...store.paths };
      for (const f of frames.values()) { if (safePath(f.path)) paths[f.env.origin] = f.path; }
      store.paths = paths;
      store.active = active ? frames.get(active).env.origin : null;
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* storage blocked */ }
    }

    function ensureStage() {
      if (stage && stage.isConnected) return stage;
      stage = make('div', '', { id: 'envsw-stage', 'data-envsw': '' });
      stage.append(make('div', 'envsw-stage-inner'));
      document.body.appendChild(stage);
      return stage;
    }

    function postTo(f, msg) {
      try { f.el.contentWindow.postMessage(msg, f.env.origin); } catch { /* frame gone */ }
    }

    function createFrame(env) {
      const f = { env, el: null, overlay: null, status: 'loading', waiting: 0, title: '', path: safePath(store.paths[env.origin]) || '/',
        helloSinceLoad: false, graceTimer: null, hardTimer: null, lastLoadAt: 0 };
      const el = make('iframe', 'envsw-frame', {
        title: `${env.name} (${env.host})`,
        allow: 'clipboard-read; clipboard-write; microphone; fullscreen', // set before src
      });
      el.addEventListener('load', () => onFrameLoad(f), { signal });
      f.el = el;
      frames.set(env.id, f);
      ensureStage().firstChild.appendChild(el);
      navigateFrame(f);
      return f;
    }

    function navigateFrame(f) {
      f.helloSinceLoad = false;
      setStatus(f, 'loading');
      life.cancel(f.hardTimer);
      f.hardTimer = life.later(() => { if (f.status === 'loading') setStatus(f, 'blocked'); }, HELLO_HARD_MS);
      f.lastLoadAt = Date.now();
      f.el.src = frameUrl(f.env, f.path);
    }

    // A blocked frame (Access login refuses framing) still fires load, but never says hello.
    function onFrameLoad(f) {
      life.cancel(f.graceTimer);
      if (f.helloSinceLoad) { f.helloSinceLoad = false; return; }
      f.graceTimer = life.later(() => {
        if (f.helloSinceLoad) f.helloSinceLoad = false;
        else setStatus(f, 'blocked');
      }, HELLO_GRACE_MS);
    }

    function onHello(f) {
      f.helloSinceLoad = true;
      life.cancel(f.hardTimer);
      setStatus(f, 'ready');
      postTo(f, { type: 'envsw:init' });
      publishWaiting();
    }

    function setStatus(f, status) {
      if (f.status === status) return;
      f.status = status;
      renderOverlay(f);
      renderMenu();
    }

    function unload(f) {
      life.cancel(f.graceTimer);
      life.cancel(f.hardTimer);
      f.el.remove();
      if (f.overlay) f.overlay.remove();
      frames.delete(f.env.id);
      if (active === f.env.id) switchTo(null);
      else { saveStore(); renderMenu(); }
      publishWaiting();
    }

    // ---- view ----

    function setInert(on) {
      if (on) {
        for (const el of document.body.children) {
          if (el.hasAttribute('data-envsw') || el.hasAttribute('inert')) continue;
          el.setAttribute('inert', '');
          inerted.add(el);
        }
      } else {
        inerted.forEach((el) => el.removeAttribute('inert'));
        inerted.clear();
      }
    }

    function focusFrame(f) {
      f.el.focus();
      try { f.el.contentWindow.focus(); } catch { /* ignore */ }
    }

    function switchTo(id) {
      closeMenu();
      if (id !== null && !remotes.some((e) => e.id === id)) return;
      const f = id === null ? null : frames.get(id) || createFrame(remotes.find((e) => e.id === id));
      active = id;
      const html = document.documentElement;
      for (const other of frames.values()) {
        other.el.classList.toggle('envsw-on', other === f);
        renderOverlay(other);
      }
      if (f) {
        html.setAttribute('data-envsw-remote', f.env.name);
        ensureStage().classList.add('envsw-on');
        if (document.activeElement instanceof HTMLElement && !document.activeElement.hasAttribute('data-envsw')) document.activeElement.blur();
        setInert(true);
        focusFrame(f);
      } else {
        html.removeAttribute('data-envsw-remote');
        if (stage) stage.classList.remove('envsw-on');
        setInert(false);
        try { window.focus(); } catch { /* ignore */ }
      }
      syncTitle();
      saveStore();
      paintLogos();
    }

    function switchToIndex(index) {
      const env = envs[index];
      if (!env) return;
      if (env === self) switchTo(null);
      else if (remotes.includes(env)) switchTo(env.id);
      else window.open(env.origin, '_blank', 'noopener');
    }

    // While a remote env is visible the tab shows its title; the home app keeps writing its own
    // title meanwhile, which is remembered for the way back.
    function syncTitle() {
      const f = active ? frames.get(active) : null;
      if (!f) {
        if (writtenTitle !== null) {
          if (document.title === writtenTitle) document.title = homeTitle;
          writtenTitle = null;
        }
        return;
      }
      const text = `${f.env.name} · ${f.title || f.env.host}`;
      if (document.title === text) return;
      if (document.title !== writtenTitle) homeTitle = document.title;
      writtenTitle = text;
      document.title = text;
    }

    // ---- sign-in overlay ----

    function renderOverlay(f) {
      const show = active === f.env.id && (f.status === 'auth' || f.status === 'blocked');
      if (!show) {
        if (f.overlay) { f.overlay.remove(); f.overlay = null; }
        return;
      }
      if (!f.overlay || !f.overlay.isConnected) {
        f.overlay = make('div', 'envsw-overlay', { 'data-envsw': '' });
        ensureStage().firstChild.appendChild(f.overlay);
      }
      const card = make('div', 'envsw-card', { role: 'alertdialog', 'aria-live': 'polite' });
      const title = make('div', 'envsw-card-title');
      const text = make('p', 'envsw-card-text');
      if (f.status === 'auth') {
        title.textContent = `${f.env.name}: sign-in expired`;
        text.textContent = 'Cloudflare Access can’t show its sign-in page inside another window. Sign in in a popup and this reconnects.';
      } else {
        title.textContent = `Couldn’t open ${f.env.name} here`;
        text.textContent = `${f.env.host} may need you to sign in, or the machine may be offline.`;
      }
      const actions = make('div', 'envsw-card-actions');
      const signIn = make('button', 'envsw-btn envsw-btn-primary', { type: 'button' });
      signIn.textContent = 'Sign in';
      signIn.addEventListener('click', () => startSignIn(f));
      const newTab = make('a', 'envsw-btn', { href: frameUrl(f.env, f.path), target: '_blank', rel: 'noopener' });
      newTab.textContent = 'Open in new tab';
      const retry = make('button', 'envsw-btn', { type: 'button' });
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => retryFrame(f, true));
      const back = make('button', 'envsw-btn', { type: 'button' });
      back.textContent = `Back to ${self ? self.name : 'home'}`;
      back.addEventListener('click', () => switchTo(null));
      actions.append(signIn, newTab, retry, back);
      card.append(title, text, actions);
      f.overlay.replaceChildren(card);
    }

    function startSignIn(f) {
      authAttemptAt = Date.now();
      const url = `${f.env.origin}/?envsw=auth`;
      const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
      // An installed PWA's window.open lands in the browser, whose cookies the PWA doesn't share.
      popup = standalone ? null : window.open(url, `envsw-auth-${f.env.id}`, 'popup,width=520,height=720');
      if (!popup) {
        saveStore(); // the round trip comes back to this env
        location.assign(`${url}&return=${encodeURIComponent(location.origin)}`);
      }
    }

    // Automatic retries keep a live app (status 'auth') and only re-run its probe: its sockets
    // reconnect by themselves once Access lets requests through again. A frame that never loaded
    // the app ('blocked'), or the Retry button, reloads the iframe.
    function retryFrame(f, force) {
      if (!force && f.status === 'auth') { postTo(f, { type: 'envsw:reprobe' }); return; }
      if (!force && Date.now() - f.lastLoadAt < RETRY_MIN_MS) return;
      navigateFrame(f);
    }

    // Primary signal after a popup sign-in is this window regaining focus: the Google/Access pages
    // usually cut the popup's opener link, so envsw:authed often never arrives.
    function afterPossibleSignIn() {
      if (!authAttemptAt) {
        for (const f of frames.values()) if (f.status === 'blocked' && active === f.env.id) retryFrame(f, false);
        return;
      }
      for (const f of frames.values()) if (f.status === 'auth' || f.status === 'blocked') retryFrame(f, false);
      if (Date.now() - authAttemptAt > 10 * 60000) authAttemptAt = 0;
    }

    // ---- needs-input counts ----

    function remoteWaiting() {
      let n = 0;
      for (const f of frames.values()) n += f.waiting;
      return n;
    }

    function publishWaiting() {
      const remote = remoteWaiting();
      const html = document.documentElement;
      if (html.dataset.envswWaiting !== String(remote)) {
        html.dataset.envswWaiting = String(remote);
        dispatchEvent(new CustomEvent('envsw:waiting')); // cleanup.js folds it into the favicon pulse
      }
      const total = localWaiting() + remote;
      for (const f of frames.values()) postTo(f, { type: 'envsw:peers', count: total - f.waiting });
      paintLogos();
      renderMenu();
    }

    function paintLogos() { markLogos(self ? self.name : 'Local', remoteWaiting() > 0); }

    // ---- menu ----

    function rowState(env) {
      if (env === self) return 'here';
      if (!remotes.includes(env)) return 'tab';
      const f = frames.get(env.id);
      if (!f) return 'idle';
      return f.status === 'blocked' ? 'auth' : f.status;
    }

    function stateLabel(state) {
      return { here: 'this window', tab: 'opens in a new tab', idle: 'not loaded', loading: 'loading', ready: 'loaded', auth: 'needs sign-in', down: 'offline' }[state] || state;
    }

    function openMenu(anchor) {
      if (menu) { closeMenu(); return; }
      const backdrop = make('div', 'envsw-backdrop', { 'data-envsw': '' });
      const box = make('div', 'envsw-menu', { 'data-envsw': '', role: 'menu', 'aria-label': 'Environments' });
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) { e.preventDefault(); closeMenu(); } });
      box.addEventListener('keydown', onMenuKey);
      document.body.append(backdrop, box);
      menu = { backdrop, box, anchor };
      renderMenu();
      const current = box.querySelector('.envsw-row[aria-current="true"] .envsw-item') || box.querySelector('.envsw-item');
      if (current) current.focus();
    }

    function closeMenu() {
      if (!menu) return;
      menu.backdrop.remove();
      menu.box.remove();
      menu = null;
      const f = active ? frames.get(active) : null;
      if (f) focusFrame(f);
    }

    function onMenuKey(e) {
      const items = [...menu.box.querySelectorAll('.envsw-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    }

    function renderMenu() {
      if (!menu) return;
      const { box, anchor } = menu;
      const focusedIndex = [...box.querySelectorAll('.envsw-item')].indexOf(document.activeElement);
      const head = make('div', 'envsw-menu-head');
      head.textContent = 'Environments';
      const rows = [head];
      if (!self) rows.push(menuRow({ env: null, name: 'This server', host: location.host, state: 'here', current: true }));
      for (const env of envs) {
        const state = rowState(env);
        const f = frames.get(env.id);
        const waiting = env === self ? localWaiting() : f ? f.waiting : 0;
        rows.push(menuRow({ env, name: env.name, host: env.host, state, waiting,
          current: env === self ? active === null : active === env.id, loaded: !!f }));
      }
      box.replaceChildren(...rows);
      const items = box.querySelectorAll('.envsw-item');
      if (focusedIndex >= 0 && items[focusedIndex]) items[focusedIndex].focus();
      const width = Math.min(340, window.innerWidth - 16);
      box.style.left = `${Math.round(Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)))}px`;
      box.style.top = `${Math.round(Math.min(anchor.bottom + 6, window.innerHeight - box.offsetHeight - 8))}px`;
    }

    function menuRow({ env, name, host, state, waiting, current, loaded }) {
      const row = make('div', 'envsw-row', { 'data-state': state });
      if (current) row.setAttribute('aria-current', 'true');
      const item = make('button', 'envsw-item', { type: 'button', role: 'menuitem', title: `${name}: ${stateLabel(state)}` });
      const dot = make('span', 'envsw-dot', { 'aria-hidden': 'true' });
      const label = make('span', 'envsw-label');
      const nameEl = make('span', 'envsw-name');
      nameEl.textContent = name;
      const hostEl = make('span', 'envsw-host');
      hostEl.textContent = `${host} · ${stateLabel(state)}`;
      label.append(nameEl, hostEl);
      item.append(dot, label);
      if (waiting > 0) {
        const count = make('span', 'envsw-count', { title: `${waiting} waiting on you` });
        count.textContent = String(waiting);
        item.append(count);
      }
      if (env) {
        const kbd = make('kbd', 'envsw-kbd');
        kbd.textContent = `⌃⌥${env.index + 1}`;
        item.append(kbd);
      }
      item.addEventListener('click', () => {
        if (!env || env === self) switchTo(null);
        else if (remotes.includes(env)) switchTo(env.id);
        else { closeMenu(); window.open(env.origin, '_blank', 'noopener'); }
      });
      row.append(item);
      if (env) {
        const f = frames.get(env.id);
        const open = make('a', 'envsw-act', { href: frameUrl(env, f ? f.path : '/'), target: '_blank', rel: 'noopener', title: 'Open in new tab', 'aria-label': `Open ${name} in new tab` });
        open.textContent = '↗';
        open.addEventListener('click', () => closeMenu());
        row.append(open);
        if (loaded && env !== self) {
          const drop = make('button', 'envsw-act', { type: 'button', title: 'Unload (frees memory)', 'aria-label': `Unload ${name}` });
          drop.textContent = '×';
          drop.addEventListener('click', (e) => { e.stopPropagation(); unload(f); });
          row.append(drop);
        }
      }
      return row;
    }

    // ---- messages ----

    addEventListener('message', (e) => {
      const msg = validateMessage(e.data);
      if (!msg) return;
      if (msg.type === 'envsw:authed') {
        if (popup && e.source === popup && envs.some((env) => env.origin === e.origin)) afterPossibleSignIn();
        return;
      }
      let f = null;
      for (const candidate of frames.values()) if (candidate.el.contentWindow === e.source) f = candidate;
      if (!f || e.origin !== f.env.origin) return;
      switch (msg.type) {
        case 'envsw:hello': onHello(f); break;
        case 'envsw:open-menu': {
          if (active !== f.env.id) break;
          const box = f.el.getBoundingClientRect();
          openMenu({ left: box.left + msg.rect.left, top: box.top + msg.rect.top, right: box.left + msg.rect.right, bottom: box.top + msg.rect.bottom });
          break;
        }
        case 'envsw:title': f.title = msg.title; syncTitle(); break;
        case 'envsw:path': f.path = msg.path; saveStore(); break;
        case 'envsw:waiting': f.waiting = msg.count; publishWaiting(); break;
        case 'envsw:probe':
          if (msg.state === 'auth') setStatus(f, 'auth');
          else if (msg.state === 'down') setStatus(f, 'down');
          else if (msg.state === 'ok' && f.status !== 'loading') setStatus(f, 'ready');
          break;
        case 'envsw:activate-me': switchTo(f.env.id); break;
        case 'envsw:switch': switchToIndex(msg.index); break;
        default: break;
      }
    }, { signal });

    addEventListener('uic:waiting', publishWaiting, { signal });
    addEventListener('focus', afterPossibleSignIn, { signal });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') afterPossibleSignIn(); }, { signal });
    addEventListener('blur', () => closeMenu(), { signal }); // the backdrop keeps focus out of the frames, so blur = left the window
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'notification:navigate') switchTo(null); // the home app navigates itself
      }, { signal });
    }

    const probes = startProbeLoop(life, (state) => {
      if (state === 'auth') {
        showBanner(`Your sign-in to ${self ? self.name : location.host} expired.`, { label: 'Reload', run: () => location.reload() });
      } else if (bannerEl) {
        hideBanner();
      }
    });

    whenReady(() => {
      bindLogoInput(life, (rect) => openMenu(rect), switchToIndex);
      watchLogos(life, paintLogos);
      life.observe(document.head, syncTitle, { childList: true, subtree: true, characterData: true });
      const restore = remotes.find((e) => e.origin === store.active);
      if (restore) switchTo(restore.id);
      probes.run();
    });

    return {
      mode: 'host',
      frames,
      get active() { return active; },
      get menuOpen() { return !!menu; },
      switchTo,
      switchToIndex,
      openMenu,
      closeMenu,
      destroy() {
        closeMenu();
        setInert(false);
        for (const f of [...frames.values()]) { f.el.remove(); if (f.overlay) f.overlay.remove(); }
        frames.clear();
        if (stage) stage.remove();
        document.documentElement.removeAttribute('data-envsw-remote');
        life.destroy();
      },
    };
  }

  // ---- Entry ----

  function start(options) {
    const opts = options || {};
    const configEl = document.getElementById('envsw-config');
    const envs = parseConfig(configEl ? configEl.textContent : '');
    if (envs.length === 0) return null;
    const self = envs.find((e) => e.origin === location.origin) || null;
    const framed = opts.framed !== undefined ? opts.framed : isFramed();
    if (!framed && new URLSearchParams(location.search).get('envsw') === 'auth') {
      if (handleAuthLanding(envs, self, new URLSearchParams(location.search))) return { mode: 'auth' };
    }
    if (framed) return self ? startEmbedded(envs, self) : null;
    return startHost(envs, self);
  }

  const api = { parseConfig, safePath, classifyProbe, validateMessage, returnOrigin, shortcutIndex, frameUrl, start };
  const testHook = globalThis.__ENVSW_TEST__;
  if (testHook && typeof testHook === 'object') {
    Object.assign(testHook, api);
    return;
  }
  try { start(); } catch (err) { console.warn('[env-switcher]', err); }
})();
