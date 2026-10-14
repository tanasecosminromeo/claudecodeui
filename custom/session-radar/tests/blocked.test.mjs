// @vitest-environment node
import { afterAll, beforeAll, expect, it as test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockedRows } from '../blocked.mjs';

// A temp DB with the columns blockedRows reads; never the live CloudCLI database.
let dir; let db;
beforeAll(async () => {
  process.removeAllListeners('warning');
  const { DatabaseSync } = await import('node:sqlite');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-blocked-'));
  db = new DatabaseSync(path.join(dir, 'auth.db'));
  db.exec(`
    CREATE TABLE projects (project_path TEXT PRIMARY KEY, custom_project_name TEXT);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, provider_session_id TEXT, custom_name TEXT,
      project_path TEXT, isArchived BOOLEAN DEFAULT 0, status TEXT);
    INSERT INTO projects VALUES ('/work/app', 'App'), ('/work/other', NULL);
    INSERT INTO sessions (session_id, provider_session_id, custom_name, project_path, isArchived,
      status) VALUES
      ('app-1', 'prov-1', 'Fix login', '/work/app', 0, 'blocked'),
      ('app-2', NULL, NULL, '/work/other', 0, 'blocked'),
      ('app-3', 'prov-3', 'Old', '/work/app', 1, 'blocked'),
      ('app-4', 'prov-4', 'Done', '/work/app', 0, 'done'),
      ('app-5', 'prov-5', 'Working', '/work/app', 0, 'blocked');
  `);
});
afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lists non-archived blocked sessions with title and project', () => {
  expect(blockedRows(db, [])).toEqual([
    { sessionId: 'prov-1', appSessionId: 'app-1', title: 'Fix login', project: 'App' },
    { sessionId: 'app-2', appSessionId: 'app-2', title: 'app-2', project: 'other' },
    { sessionId: 'prov-5', appSessionId: 'app-5', title: 'Working', project: 'App' },
  ]);
});

test('leaves out a blocked session whose live row is busy', () => {
  const busy = [{ sessionId: 'prov-5', appSessionId: 'app-5', state: 'busy' }];
  expect(blockedRows(db, busy).map((r) => r.appSessionId)).toEqual(['app-1', 'app-2']);
  // a waiting live row does not hide it
  const waiting = [{ sessionId: 'prov-5', appSessionId: 'app-5', state: 'waiting' }];
  expect(blockedRows(db, waiting).map((r) => r.appSessionId)).toEqual(['app-1', 'app-2', 'app-5']);
});

test('answers [] without a database or without the status column', async () => {
  expect(blockedRows(null, [])).toEqual([]);
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(':memory:');
  legacy.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY);'
    + 'CREATE TABLE projects (project_path TEXT);');
  expect(blockedRows(legacy, [])).toEqual([]);
  legacy.close();
});
