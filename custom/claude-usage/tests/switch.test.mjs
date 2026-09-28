import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderUsage } from '../index.js';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

// Stands in for claude-swap: `list --json` reports the active account kept in $HOME/active, `switch N` sets it.
const FAKE_SWAP = `#!/bin/sh
state="$HOME/active"
[ -f "$state" ] || echo 1 > "$state"
a=$(cat "$state")
case "$1" in
  list) t1=false; t2=false; [ "$a" = 1 ] && t1=true; [ "$a" = 2 ] && t2=true
    printf '{"activeAccountNumber":%s,"accounts":[{"number":1,"email":"one@example.com","active":%s,"usage":{}},{"number":2,"email":"two@example.com","active":%s,"usage":{}}]}' "$a" "$t1" "$t2" ;;
  switch) echo "$2" > "$state"; echo "switched to $2" ;;
esac
`;

describe('plugin server /switch', () => {
  let home;
  let proc;
  let base;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-'));
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude-swap'), FAKE_SWAP, { mode: 0o755 });
    proc = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
    const ready = await new Promise((resolve, reject) => {
      proc.stdout.once('data', (chunk) => resolve(JSON.parse(String(chunk))));
      proc.once('exit', (code) => reject(new Error(`server exited ${code}`)));
    });
    base = `http://127.0.0.1:${ready.port}`;
  });

  afterAll(() => {
    proc.kill();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const post = (body) => fetch(`${base}/switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  it('switches to a known account and returns fresh usage', async () => {
    expect((await (await fetch(`${base}/usage`)).json()).activeAccountNumber).toBe(1);
    const res = await post(JSON.stringify({ number: 2 }));
    expect(res.status).toBe(200);
    const usage = await res.json();
    expect(usage.activeAccountNumber).toBe(2);
    expect(usage.accounts.find((a) => a.active).email).toBe('two@example.com');
    expect(usage.codex).toBeNull(); // no ~/.codex in this HOME
  });

  it('rejects unknown accounts and malformed bodies', async () => {
    expect((await post(JSON.stringify({ number: 7 }))).status).toBe(400);
    expect((await post(JSON.stringify({ number: '1; rm -rf /' }))).status).toBe(400);
    expect((await post('{nope')).status).toBe(400);
    expect((await post(JSON.stringify({ pad: 'x'.repeat(4000) }))).status).toBe(413);
  });
});

describe('Switch button', () => {
  const data = (active) => ({
    fetchedAt: new Date().toISOString(),
    accounts: [1, 2].map((n) => ({ number: n, email: `${n}@example.com`, active: n === active, fiveHour: { pct: 1 }, sevenDay: { pct: 2 }, scoped: [] })),
  });

  async function mount(options) {
    const container = document.createElement('div');
    document.body.append(container);
    const handle = renderUsage(container, { fetchData: async () => data(1), pollMs: 1e9, ...options });
    await new Promise((r) => { setTimeout(r, 0); });
    return { container, handle };
  }

  it('needs a confirming second click, then shows the new active account', async () => {
    const switchAccount = vi.fn(async () => data(2));
    const onData = vi.fn();
    const { container, handle } = await mount({ switchAccount, onData });
    const buttons = () => [...container.querySelectorAll('.cu-switch')];
    expect(buttons()).toHaveLength(1);
    buttons()[0].click();
    expect(switchAccount).not.toHaveBeenCalled();
    expect(buttons()[0].textContent).toBe('Switch to #2?');
    buttons()[0].click();
    await vi.waitFor(() => expect(onData).toHaveBeenCalled());
    expect(switchAccount).toHaveBeenCalledWith(2);
    expect(container.querySelector('.cu-active').textContent).toContain('2@example.com');
    handle.destroy();
  });

  it('has no Switch button without a switchAccount handler', async () => {
    const { container, handle } = await mount({});
    expect(container.querySelector('.cu-switch')).toBeNull();
    handle.destroy();
  });
});
