// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastMessageOf, sessionInfo } from '../sessions.mjs';

let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'share-sess-')); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const line = (o) => JSON.stringify(o);
function transcript(id, lines) {
  const dir = path.join(home, '.claude', 'projects', '-w-p');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.map(line).join('\n')}\n`);
}

describe('lastMessageOf', () => {
  it('takes the last user or assistant text, skipping tool traffic and system-ish lines', () => {
    const text = [
      line({ type: 'user', message: { content: 'first question' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here is   the\nanswer' }, { type: 'tool_use', id: 't', name: 'Bash' }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] } }),
      line({ type: 'user', message: { content: '<task-notification>x</task-notification>' } }),
      line({ type: 'system', content: 'ignored' }),
      'not json',
    ].join('\n');
    expect(lastMessageOf(text)).toBe('Here is the answer');
  });

  it('cuts long messages to 140 characters with an ellipsis', () => {
    const msg = lastMessageOf(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'a'.repeat(300) }] } }));
    expect(msg).toHaveLength(140);
    expect(msg.endsWith('…')).toBe(true);
  });

  it('returns null when there is no text', () => {
    expect(lastMessageOf('')).toBeNull();
  });
});

describe('sessionInfo', () => {
  it('reports a live session from its status file with its last message', () => {
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'sessions', `${process.pid}.json`),
      line({ pid: process.pid, sessionId: 'live-1', cwd: '/w/p', name: 'my-chat', status: 'busy' }));
    transcript('live-1', [{ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } }]);
    const info = sessionInfo(['live-1'], { home }).get('live-1');
    expect(info).toMatchObject({ status: 'busy', title: 'my-chat', project: 'p', lastMessage: 'working on it', appSessionId: 'live-1', archived: false });
  });

  it('uses CloudCLI names, archive flag and app session id from auth.db', () => {
    fs.mkdirSync(path.join(home, '.cloudcli'), { recursive: true });
    const db = new DatabaseSync(path.join(home, '.cloudcli', 'auth.db'));
    db.exec(`CREATE TABLE sessions (session_id TEXT, provider_session_id TEXT, custom_name TEXT, isArchived INTEGER, project_path TEXT);
             CREATE TABLE projects (project_path TEXT, custom_project_name TEXT);
             INSERT INTO sessions VALUES ('app-9', 'claude-9', 'Nice name', 1, '/w/p');
             INSERT INTO projects VALUES ('/w/p', 'Project P');`);
    db.close();
    const info = sessionInfo(['claude-9'], { home }).get('claude-9');
    expect(info).toMatchObject({ status: 'archived', archived: true, title: 'Nice name', project: 'Project P', appSessionId: 'app-9' });
  });

  it('degrades to an ended session with only the id when nothing is known', () => {
    const info = sessionInfo(['abcdef1234'], { home }).get('abcdef1234');
    expect(info).toMatchObject({ status: 'ended', title: 'abcdef12', lastMessage: null, appSessionId: 'abcdef1234' });
  });
});
