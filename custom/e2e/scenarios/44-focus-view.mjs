// The Projects star chip's Focus state. Focus shows only projects with a session
// active in the last 24 h, and opens every project and group in the list, even
// the ones the user collapsed. Groups with no active project are hidden. Turning
// Focus off (the chip's next state, then off) restores the saved open/closed state.
import fs from 'node:fs';
import path from 'node:path';

export const meta = {
  title: 'Focus in the star chip shows only projects active in the last 24h, opens every group, and leaves the saved open/closed state alone',
  timeoutMs: 300000,
  model: 'haiku',
  allowDialogs: true,
};

const RECENT_GROUP = 'client-a';
const IDLE_GROUP = 'client-b-site';

export async function run({ chat, page, app, paths, expect, snapshot, log }) {
  const api = async (method, url, body) => {
    const response = await fetch(`${app.base}${url}`, {
      method,
      headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response.json().catch(() => ({}));
  };

  // recent gets a fresh session during the run; idle never gets one.
  const recentName = 'e2e-focus-recent';
  const idleName = 'e2e-focus-idle';
  const projectIds = {};
  const dirOf = (name) => path.join(path.dirname(paths.project), name);

  // Removes this scenario's groups and projects. Runs first too: the e2e database
  // outlives a run, and a failed run leaves them behind, which makes creating fail.
  const cleanUp = async () => {
    const groups = await api('GET', '/api/projects/groups');
    for (const entry of groups.data?.groups ?? []) {
      if (entry.name === RECENT_GROUP || entry.name === IDLE_GROUP) {
        await api('DELETE', `/api/projects/groups/${entry.groupId}`);
      }
    }
    const list = await api('GET', '/api/projects?skipSync=1');
    const projects = Array.isArray(list) ? list : list.projects ?? list.data?.projects ?? [];
    const ours = new Set([recentName, idleName].map(dirOf));
    for (const project of projects) {
      if (ours.has(project.fullPath ?? project.path)) {
        await api('DELETE', `/api/projects/${project.projectId}`);
      }
    }
    // The chip's value lives on the account and loads after the first render, so a
    // value left by a failed run would flip the chip under the first click.
    await api('PATCH', '/api/user/preferences', { projectStarFilter: 'off' });
  };
  await cleanUp();

  try {
    for (const name of [recentName, idleName]) {
      const dir = dirOf(name);
      fs.mkdirSync(dir, { recursive: true });
      const created = await api('POST', '/api/projects/create-project', { path: dir });
      projectIds[name] = created.project?.projectId ?? created.data?.project?.projectId;
      expect(Boolean(projectIds[name]), `created project ${name}`);
    }

    await page.goto(`${app.base}/`);
    const row = (name) => page.getByRole('button', { name: new RegExp(`^${name}`) });
    const group = (name) => page.locator(`[data-testid="project-group"][data-group-name="${name}"]`);
    const toggle = (name) => group(name).locator('[data-testid="project-group-toggle"]');
    const chip = page.locator('[data-testid="starred-filter"]:visible');
    await row(recentName).waitFor({ timeout: 20000 });

    // Put each project in its own group through the row menu, as scenario 26 does.
    const moveToNewGroup = async (name, groupName) => {
      chat.onDialog = (dialog) => (dialog.type === 'prompt' ? groupName : false);
      await row(name).hover();
      await row(name).locator('[data-testid="project-move-to-group"]').click();
      const menu = page.locator('[data-testid="project-group-menu"]');
      await menu.waitFor({ timeout: 5000 });
      await menu.getByRole('menuitem', { name: 'New group…' }).click();
      await group(groupName).waitFor({ timeout: 10000 });
      chat.onDialog = null;
    };
    await moveToNewGroup(recentName, RECENT_GROUP);
    await moveToNewGroup(idleName, IDLE_GROUP);

    // A fresh session in the recent project, so it is active within the last 24 h.
    await row(recentName).click();
    const newSession = page.getByRole('button', { name: 'New Session' });
    if (await newSession.isVisible().catch(() => false)) {
      await newSession.click();
    }
    await chat.send('reply with the single word PONG');
    await chat.waitForAssistant(/PONG/, 90000);
    log('the recent project has a session from this run');

    // Back to the list. Collapse both groups first, so the saved state is closed.
    await page.goto(`${app.base}/`);
    await group(RECENT_GROUP).waitFor({ timeout: 20000 });
    await toggle(RECENT_GROUP).click();
    await toggle(IDLE_GROUP).click();
    expect(await toggle(RECENT_GROUP).getAttribute('aria-expanded') === 'false', 'the recent group is collapsed before Focus');
    expect(await toggle(IDLE_GROUP).getAttribute('aria-expanded') === 'false', 'the idle group is collapsed before Focus');

    // The chip starts off. Normalise it first, in case an earlier run left it elsewhere.
    for (let step = 0; step < 3 && (await chip.getAttribute('data-star-filter')) !== 'off'; step += 1) {
      await chip.click();
    }
    expect(await chip.getAttribute('data-star-filter') === 'off', 'the chip starts off');

    // off -> focus.
    await chip.click();
    expect(await chip.getAttribute('data-star-filter') === 'focus', 'the first click moves the chip to focus');
    expect(await chip.getAttribute('aria-pressed') === 'true', 'the focus chip is pressed');
    await group(RECENT_GROUP).waitFor({ timeout: 10000 });
    expect(await toggle(RECENT_GROUP).getAttribute('aria-expanded') === 'true', 'focus opens the recent group even though it was collapsed');
    expect(await group(RECENT_GROUP).getByRole('button', { name: new RegExp(`^${recentName}`) }).count() === 1, 'focus shows the project with a fresh session inside its group');
    expect(await group(RECENT_GROUP).getByText(/reply with/i).count() >= 1, 'focus lists the fresh session under its project');
    expect(await group(IDLE_GROUP).count() === 0, 'a group with no active project is hidden in focus');
    expect(await row(idleName).count() === 0, 'a project with no active session is hidden in focus');
    await snapshot('focus: recent project opened, idle group hidden');

    // focus -> all: starred projects only. Nothing here is starred, so the list is empty.
    await chip.click();
    expect(await chip.getAttribute('data-star-filter') === 'all', 'the second click moves the chip to starred');
    expect(await row(recentName).count() === 0, 'the starred state hides the unstarred project');

    // all -> off: the saved state comes back, closed as it was before Focus.
    await chip.click();
    expect(await chip.getAttribute('data-star-filter') === 'off', 'the third click turns the chip off');
    await group(IDLE_GROUP).waitFor({ timeout: 10000 });
    expect(await toggle(IDLE_GROUP).getAttribute('aria-expanded') === 'false', 'the idle group is still collapsed after Focus');
    expect(await toggle(RECENT_GROUP).getAttribute('aria-expanded') === 'false', 'the recent group is collapsed again after Focus');
    expect(await row(recentName).count() === 0, 'the recent project is inside its collapsed group again');
    await snapshot('focus off: saved open/closed state restored');
  } finally {
    // Clean up so later scenarios see the usual sidebar, whether or not this one passed.
    await cleanUp();
    log('removed the test groups and projects');
  }
}
