// The "Needs input" markers in the sidebar. Two projects with one session each;
// both sessions are faked as waiting in this browser's copy of the Session Radar
// answer (nothing is written to ~/.claude/sessions, so no push goes out). Each
// session row shows the orange dot, and each project row shows a count of 1 that
// survives a reload. Then one session turns busy and its marker and count go.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const meta = {
  title: 'Waiting sessions show the Needs input dot on their row and a count on their project, across a reload, and clear when the session turns busy',
  timeoutMs: 360000,
  model: 'haiku',
  allowDialogs: false,
};

const NAMES = ['e2e-marker-a', 'e2e-marker-b'];

export async function run({ chat, page, app, paths, expect, snapshot, log }) {
  const api = async (method, url, body) => {
    const response = await fetch(`${app.base}${url}`, {
      method,
      headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response.json().catch(() => ({}));
  };
  const dirOf = (name) => path.join(path.dirname(paths.project), name);
  // Claude Code's transcript folder for a project folder (same rule as lib/instance.mjs).
  const transcriptsOf = (name) => path.join(os.homedir(), '.claude', 'projects', dirOf(name).replace(/[^A-Za-z0-9]/g, '-'));
  const waitUntil = async (check, timeoutMs = 30000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return true;
      if (Date.now() > end) return false;
      await page.waitForTimeout(500);
    }
  };

  // Removes this scenario's projects. Runs first too: the e2e database outlives a run.
  const cleanUp = async () => {
    const list = await api('GET', '/api/projects?skipSync=1');
    const projects = Array.isArray(list) ? list : list.projects ?? list.data?.projects ?? [];
    const ours = new Set(NAMES.map(dirOf));
    for (const project of projects) {
      if (ours.has(project.fullPath ?? project.path)) {
        await api('DELETE', `/api/projects/${project.projectId}`);
      }
    }
    for (const name of NAMES) {
      fs.rmSync(transcriptsOf(name), { recursive: true, force: true });
    }
  };
  await cleanUp();

  // The leftover-processes list opens once per fresh instance and covers the sidebar.
  // It lists processes of the whole machine, not of this test, so close it when it shows.
  const closeLeftovers = async () => {
    const close = page.locator('#uic-leftovers .uic-lo-close');
    if (await close.waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false)) {
      await close.click();
    }
  };

  // The radar answer the browser sees: our two sessions, with the state set below.
  // titles: the project name each faked session belongs to, keyed by its app session id.
  const fake = { states: {}, titles: {} };
  await page.route('**/api/plugins/*/rpc/sessions', async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    const ids = new Set(Object.keys(fake.states));
    const others = (body.sessions || []).filter((s) => s.state !== 'waiting' && !ids.has(s.appSessionId || s.sessionId));
    const ours = Object.entries(fake.states).map(([appSessionId, state]) => ({
      sessionId: `provider-${appSessionId}`,
      appSessionId,
      state,
      entrypoint: 'web',
      waitingFor: state === 'waiting' ? 'your answer' : null,
      pending: null,
      title: fake.titles[appSessionId],
      project: fake.titles[appSessionId],
    }));
    await route.fulfill({ response, json: { ...body, sessions: [...others, ...ours] } });
  });

  try {
    // Two projects, one session each. The session is a real reply, as in scenario 44.
    const ids = {};
    for (const name of NAMES) {
      const created = await api('POST', '/api/projects/create-project', { path: dirOf(name) });
      const projectId = created.project?.projectId ?? created.data?.project?.projectId;
      expect(Boolean(projectId), `created project ${name}`);
    }
    for (const name of NAMES) {
      await page.goto(`${app.base}/`);
      const row = page.getByRole('button', { name: new RegExp(`^${name}`) });
      await row.waitFor({ timeout: 20000 });
      await closeLeftovers();
      await row.click();
      const newSession = page.getByRole('button', { name: 'New Session' });
      if (await newSession.isVisible().catch(() => false)) {
        await newSession.click();
      }
      await chat.send('reply with the single word PONG');
      await chat.waitForAssistant(/PONG/, 90000);
      ids[name] = await chat.sessionId();
      fake.titles[ids[name]] = name;
      log(`${name} has session ${ids[name]}`);
    }
    const [a, b] = NAMES;

    // Waiting for both, then the list as a person sees it. Expands a project only when its rows are not shown.
    const row = (name) => page.getByRole('button', { name: new RegExp(`^${name}`) });
    const markerOf = (id) => page.locator(`a[href="/session/${id}"] [role="img"][aria-label="Needs input"]:visible`);
    const countOf = (name) => row(name).locator('[data-testid="project-needs-input-count"]:visible');
    const countText = async (name) => (await countOf(name).count()) === 0 ? null : (await countOf(name).first().textContent())?.trim();
    const showRows = async (name, id) => {
      if ((await page.locator(`a[href="/session/${id}"]:visible`).count()) === 0) {
        await row(name).click();
      }
    };
    const openList = async () => {
      await page.goto(`${app.base}/`);
      await row(a).waitFor({ timeout: 20000 });
      await closeLeftovers();
      await showRows(a, ids[a]);
      await showRows(b, ids[b]);
    };

    fake.states = { [ids[a]]: 'waiting', [ids[b]]: 'waiting' };
    await openList();
    const bothMarked = await waitUntil(async () => (await markerOf(ids[a]).count()) === 1
      && (await markerOf(ids[b]).count()) === 1 && (await countText(a)) === '1' && (await countText(b)) === '1');
    expect(bothMarked, `before reload: both rows show the dot and both projects count 1 (rows ${await markerOf(ids[a]).count()}/${await markerOf(ids[b]).count()}, counts ${await countText(a)}/${await countText(b)})`);
    await snapshot('desktop sidebar: both sessions waiting, both projects count 1');

    await page.reload();
    await openList();
    const afterReload = await waitUntil(async () => (await markerOf(ids[a]).count()) === 1
      && (await markerOf(ids[b]).count()) === 1 && (await countText(a)) === '1' && (await countText(b)) === '1');
    expect(afterReload, `after reload: both rows show the dot and both projects count 1 (rows ${await markerOf(ids[a]).count()}/${await markerOf(ids[b]).count()}, counts ${await countText(a)}/${await countText(b)})`);

    // B turns busy (its status is not blocked): its dot and count go, A keeps its own.
    fake.states = { [ids[a]]: 'waiting', [ids[b]]: 'busy' };
    const bCleared = await waitUntil(async () => (await markerOf(ids[b]).count()) === 0 && (await countText(b)) === null);
    expect(bCleared, 'busy: the busy session loses its dot and its project loses the count');
    expect((await markerOf(ids[a]).count()) === 1 && (await countText(a)) === '1', 'busy: the waiting session keeps its dot and count');
    await snapshot('desktop sidebar: one session busy, its marker gone');

    // Phone: the same list in the phone layout.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(800);
    const openMenu = page.getByRole('button', { name: 'Open menu', exact: true });
    if (await openMenu.isVisible().catch(() => false)) {
      await openMenu.click();
      await page.waitForTimeout(800);
    }
    const phoneDots = page.locator('[role="img"][aria-label="Needs input"]:visible');
    const phoneCounts = page.locator('[data-testid="project-needs-input-count"]:visible');
    expect((await phoneDots.count()) === 1, `phone: one dot, for the waiting session (found ${await phoneDots.count()})`);
    expect((await phoneCounts.count()) === 1 && (await phoneCounts.first().textContent())?.trim() === '1', 'phone: the waiting session\'s project counts 1');
    await snapshot('phone sidebar: one waiting session, one dot and count');
  } finally {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.unroute('**/api/plugins/*/rpc/sessions');
    await cleanUp();
  }
}
