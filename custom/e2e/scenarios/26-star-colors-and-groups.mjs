// Gmail-style star colors and project groups in the sidebar. A click on a
// project's star moves it to the next color, a right-click opens a palette to
// pick one; "Move to group" files projects under a named, collapsible folder.
// Colors, membership and the collapsed state all survive a reload.
import fs from 'node:fs';
import path from 'node:path';

export const meta = {
  title: 'Star colors cycle and persist; projects grouped into a collapsible folder',
  timeoutMs: 120000,
  allowDialogs: true,
};

const GROUP_NAME = 'client-a';

export async function run({ chat, page, app, paths, expect, snapshot, log }) {
  const api = async (method, url, body) => {
    const response = await fetch(`${app.base}${url}`, {
      method,
      headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response.json().catch(() => ({}));
  };

  // Two extra projects next to the test project.
  const names = ['e2e-stars-a', 'e2e-stars-b'];
  const projectIds = {};
  for (const name of names) {
    const dir = path.join(path.dirname(paths.project), name);
    fs.mkdirSync(dir, { recursive: true });
    const created = await api('POST', '/api/projects/create-project', { path: dir });
    projectIds[name] = created.project?.projectId ?? created.data?.project?.projectId;
    expect(Boolean(projectIds[name]), `created project ${name}`);
  }

  const serverProject = async (name) => {
    const list = await api('GET', '/api/projects?skipSync=1');
    const projects = Array.isArray(list) ? list : list.projects ?? list.data?.projects ?? [];
    return projects.find((project) => project.projectId === projectIds[name]);
  };
  const waitForServer = async (name, check, label) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const project = await serverProject(name);
      if (project && check(project)) {
        expect(true, label);
        return;
      }
      await page.waitForTimeout(300);
    }
    expect(false, label);
  };

  await page.goto(`${app.base}/`);
  const row = (name) => page.getByRole('button', { name: new RegExp(`^${name}`) });
  const star = (name) => row(name).locator('[data-testid="project-star"]');
  await row(names[0]).waitFor({ timeout: 20000 });

  // Click cycles: none → yellow → orange.
  expect(await star(names[0]).getAttribute('data-star-color') === 'none', 'a new project is not starred');
  await star(names[0]).click();
  expect(await star(names[0]).getAttribute('data-star-color') === 'yellow', 'one click makes the star yellow');
  await star(names[0]).click();
  expect(await star(names[0]).getAttribute('data-star-color') === 'orange', 'two clicks make the star orange');
  await waitForServer(names[0], (project) => project.starColor === 'orange', 'the server stored orange');

  // Right-click palette jumps straight to a color.
  await star(names[0]).click({ button: 'right' });
  const palette = page.locator('[data-testid="star-color-palette"]');
  await palette.waitFor({ timeout: 5000 });
  await snapshot('star color palette');
  await palette.locator('[data-star-color="blue"]').click();
  expect(await palette.count() === 0, 'picking a color closes the palette');
  expect(await star(names[0]).getAttribute('data-star-color') === 'blue', 'the palette set the star to blue');
  await waitForServer(names[0], (project) => project.starColor === 'blue' && project.isStarred === true, 'the server stored blue');

  // New group from the row menu (answers the name prompt).
  chat.onDialog = (dialog) => (dialog.type === 'prompt' ? GROUP_NAME : false);
  await row(names[0]).hover();
  await row(names[0]).locator('[data-testid="project-move-to-group"]').click();
  const menu = page.locator('[data-testid="project-group-menu"]');
  await menu.waitFor({ timeout: 5000 });
  await menu.getByRole('menuitem', { name: 'New group…' }).click();
  const group = page.locator(`[data-testid="project-group"][data-group-name="${GROUP_NAME}"]`);
  await group.waitFor({ timeout: 10000 });
  chat.onDialog = null;

  // Second project joins the existing group.
  await row(names[1]).hover();
  await row(names[1]).locator('[data-testid="project-move-to-group"]').click();
  await menu.waitFor({ timeout: 5000 });
  await menu.getByRole('menuitemradio', { name: GROUP_NAME }).click();
  await group.getByRole('button', { name: new RegExp(`^${names[1]}`) }).waitFor({ timeout: 10000 });
  expect(await group.getByRole('button', { name: new RegExp(`^${names[0]}`) }).count() === 1, `${names[0]} is in the group`);
  expect(await group.getByRole('button', { name: /^e2e-project/ }).count() === 0, 'the test project stays ungrouped');
  await waitForServer(names[1], (project) => Boolean(project.groupId), 'the server stored the membership');
  await snapshot('group with two projects');

  // Collapse, and the collapse survives a reload; so do colors and membership.
  await group.locator('[data-testid="project-group-toggle"]').click();
  expect(await group.getByRole('button', { name: new RegExp(`^${names[0]}`) }).count() === 0, 'collapsing hides the projects');
  await page.reload();
  await group.waitFor({ timeout: 20000 });
  expect(await group.locator('[data-testid="project-group-toggle"]').getAttribute('aria-expanded') === 'false', 'the group is still collapsed after a reload');
  await group.locator('[data-testid="project-group-toggle"]').click();
  await group.getByRole('button', { name: new RegExp(`^${names[0]}`) }).waitFor({ timeout: 5000 });
  expect(await group.getByRole('button', { name: new RegExp(`^${names[1]}`) }).count() === 1, 'both projects are still in the group after a reload');
  expect(await star(names[0]).getAttribute('data-star-color') === 'blue', 'the blue star survived the reload');
  await snapshot('after reload');

  // Clean up so later scenarios see the usual sidebar.
  const groups = await api('GET', '/api/projects/groups');
  for (const entry of groups.data?.groups ?? []) {
    await api('DELETE', `/api/projects/groups/${entry.groupId}`);
  }
  for (const name of names) {
    await api('DELETE', `/api/projects/${projectIds[name]}`);
  }
  log('removed the test group and projects');
}
