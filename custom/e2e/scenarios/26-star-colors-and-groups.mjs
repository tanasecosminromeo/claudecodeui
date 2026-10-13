// Gmail-style star colors and project groups in the sidebar. A quick second
// click on a project's star moves it to the next color and the project stays
// where it is in the list; a click more than 3 s after the last one unstars it.
// A right-click opens a palette to pick a color; the starred-filter chip shows
// only starred projects, or only one color. "Move to group" files projects under
// a named, collapsible folder. Colors, membership and the collapsed state all
// survive a reload.
import fs from 'node:fs';
import path from 'node:path';

export const meta = {
  title: 'Star clicks recolour in place, the starred filter narrows the list, projects grouped into a collapsible folder',
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

  // Index of each e2e project in the sidebar's star order (the star sits inside its row).
  const sidebarIndexes = async () => {
    const labels = await page.locator('[data-testid="project-star"]').evaluateAll(
      (stars) => stars.map((star) => star.closest('button')?.textContent ?? ''),
    );
    return names.map((name) => labels.findIndex((label) => label.includes(name)));
  };

  // Quick clicks: none → yellow → orange, and the row does not move.
  expect(await star(names[0]).getAttribute('data-star-color') === 'none', 'a new project is not starred');
  const indexesBefore = await sidebarIndexes();
  expect(indexesBefore.every((index) => index >= 0), 'both e2e projects are in the sidebar list');
  await star(names[0]).click();
  expect(await star(names[0]).getAttribute('data-star-color') === 'yellow', 'one click makes the star yellow');
  await star(names[0]).click();
  expect(await star(names[0]).getAttribute('data-star-color') === 'orange', 'a quick second click makes the star orange');
  expect(JSON.stringify(await sidebarIndexes()) === JSON.stringify(indexesBefore), 'recolouring a star does not move the project in the list');
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

  // Starred-filter chip, with one blue project (names[0]) and one yellow (names[1]).
  const chip = page.locator('[data-testid="starred-filter"]:visible');
  const visibleProjectNames = async () => {
    const found = [];
    for (const name of names) {
      if (await row(name).count() > 0) found.push(name);
    }
    return found;
  };
  await star(names[1]).click();
  expect(await star(names[1]).getAttribute('data-star-color') === 'yellow', 'a fresh project takes yellow on its first click');
  expect(await chip.getAttribute('data-star-filter') === 'off', 'the starred filter starts off');
  await chip.click();
  expect(await chip.getAttribute('data-star-filter') === 'all', 'the first chip click shows all starred');
  expect(await page.locator('[data-testid="project-star"][data-star-color="none"]').count() === 0, 'starred filter hides unstarred projects');
  expect(JSON.stringify(await visibleProjectNames()) === JSON.stringify(names), 'starred filter keeps both starred e2e projects');
  await chip.click();
  expect(await chip.getAttribute('data-star-filter') === 'yellow', 'the next chip click picks the yellow colour');
  expect(JSON.stringify(await visibleProjectNames()) === JSON.stringify([names[1]]), 'yellow filter shows only the yellow project');
  await chip.click();
  expect(await chip.getAttribute('data-star-filter') === 'blue', 'the next chip click picks the blue colour');
  expect(JSON.stringify(await visibleProjectNames()) === JSON.stringify([names[0]]), 'blue filter shows only the blue project');
  await chip.click();
  expect(await chip.getAttribute('data-star-filter') === 'off', 'after the last colour the chip is off');
  expect(JSON.stringify(await visibleProjectNames()) === JSON.stringify(names), 'off shows the e2e projects again');
  await snapshot('starred filter off');

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

  // A click more than 3 s after the last star click unstars the project.
  await page.waitForTimeout(3200);
  await star(names[0]).click();
  expect(await star(names[0]).getAttribute('data-star-color') === 'none', 'a slow click removes the star');
  await waitForServer(names[0], (project) => !project.starColor, 'the server cleared the star');
  await page.reload();
  await row(names[0]).waitFor({ timeout: 20000 });
  expect(await star(names[0]).getAttribute('data-star-color') === 'none', 'the cleared star stays cleared after a reload');

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
