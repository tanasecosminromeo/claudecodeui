import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import {
  createProjectGroup,
  deleteProjectGroup,
  listProjectGroups,
  renameProjectGroup,
  setProjectGroup,
} from '@/modules/projects/services/project-group.service.js';
import { setProjectStarColor, toggleProjectStar } from '@/modules/projects/services/project-star.service.js';
import { AppError } from '@/shared/utils.js';

async function withIsolatedDatabase(
  runTest: () => void | Promise<void>,
  seed?: (databasePath: string) => void,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-stars-groups-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  seed?.(databasePath);
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function createProject(projectPath: string): string {
  const created = projectsDb.createProjectPath(projectPath);
  assert.ok(created.project);
  return created.project.project_id;
}

const hasErrorCode = (code: string, statusCode: number) => (error: unknown) =>
  error instanceof AppError && error.code === code && error.statusCode === statusCode;

test('setProjectStarColor stores the color and keeps isStarred mirrored', async () => {
  await withIsolatedDatabase(() => {
    const projectId = createProject('/workspace/colored');

    assert.deepEqual(setProjectStarColor(projectId, 'blue'), { starColor: 'blue' });
    let row = projectsDb.getProjectById(projectId);
    assert.equal(row?.star_color, 'blue');
    assert.equal(row?.isStarred, 1);

    assert.deepEqual(setProjectStarColor(projectId, null), { starColor: null });
    row = projectsDb.getProjectById(projectId);
    assert.equal(row?.star_color, null);
    assert.equal(row?.isStarred, 0);
  });
});

test('setProjectStarColor rejects unknown colors', async () => {
  await withIsolatedDatabase(() => {
    const projectId = createProject('/workspace/bad-color');
    assert.throws(() => setProjectStarColor(projectId, 'pink'), hasErrorCode('INVALID_STAR_COLOR', 400));
    assert.throws(() => setProjectStarColor('missing', 'red'), hasErrorCode('PROJECT_NOT_FOUND', 404));
  });
});

test('the legacy toggle-star keeps an existing color and clears it on unstar', async () => {
  await withIsolatedDatabase(() => {
    const projectId = createProject('/workspace/legacy-toggle');

    toggleProjectStar(projectId);
    assert.equal(projectsDb.getProjectById(projectId)?.star_color, 'yellow');

    setProjectStarColor(projectId, 'green');
    toggleProjectStar(projectId);
    assert.equal(projectsDb.getProjectById(projectId)?.star_color, null);
  });
});

test('groups can be created, renamed and deleted, and names are unique case-insensitively', async () => {
  await withIsolatedDatabase(() => {
    const group = createProjectGroup('  client-a ');
    assert.equal(group.name, 'client-a');
    assert.throws(() => createProjectGroup('Client-A'), hasErrorCode('GROUP_NAME_TAKEN', 409));
    assert.throws(() => createProjectGroup('   '), hasErrorCode('GROUP_NAME_REQUIRED', 400));

    createProjectGroup('AI infra');
    assert.deepEqual(listProjectGroups().map((entry) => entry.name), ['AI infra', 'client-a']);

    assert.equal(renameProjectGroup(group.groupId, 'Client-a').name, 'Client-a');
    assert.throws(() => renameProjectGroup(group.groupId, 'ai INFRA'), hasErrorCode('GROUP_NAME_TAKEN', 409));
    assert.throws(() => renameProjectGroup('missing', 'x'), hasErrorCode('GROUP_NOT_FOUND', 404));
  });
});

test('projects are assigned to groups and fall back to ungrouped when the group is deleted', async () => {
  await withIsolatedDatabase(() => {
    const pluginId = createProject('/workspace/client-a-plugin');
    const idfId = createProject('/workspace/client-a-api');
    const group = createProjectGroup('client-a');

    assert.deepEqual(setProjectGroup(pluginId, group.groupId), { groupId: group.groupId });
    setProjectGroup(idfId, group.groupId);
    assert.equal(projectsDb.getProjectById(pluginId)?.group_id, group.groupId);

    assert.deepEqual(setProjectGroup(idfId, null), { groupId: null });
    assert.equal(projectsDb.getProjectById(idfId)?.group_id, null);

    assert.throws(() => setProjectGroup(pluginId, 'missing'), hasErrorCode('GROUP_NOT_FOUND', 404));
    assert.throws(() => setProjectGroup('missing', group.groupId), hasErrorCode('PROJECT_NOT_FOUND', 404));

    deleteProjectGroup(group.groupId);
    assert.equal(projectsDb.getProjectById(pluginId)?.group_id, null);
    assert.deepEqual(listProjectGroups(), []);
  });
});

test('migration turns projects starred before colors existed into yellow', async () => {
  await withIsolatedDatabase(
    () => {
      const starred = projectsDb.getProjectById('legacy-starred');
      const plain = projectsDb.getProjectById('legacy-plain');
      assert.equal(starred?.star_color, 'yellow');
      assert.equal(starred?.group_id, null);
      assert.equal(plain?.star_color, null);
    },
    (databasePath) => {
      const db = new Database(databasePath);
      db.exec(`
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY NOT NULL,
          project_path TEXT NOT NULL UNIQUE,
          custom_project_name TEXT DEFAULT NULL,
          isStarred BOOLEAN DEFAULT 0,
          isArchived BOOLEAN DEFAULT 0
        );
        INSERT INTO projects (project_id, project_path, isStarred) VALUES ('legacy-starred', '/workspace/a', 1);
        INSERT INTO projects (project_id, project_path, isStarred) VALUES ('legacy-plain', '/workspace/b', 0);
      `);
      db.close();
    },
  );
});
