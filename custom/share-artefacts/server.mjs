// share-artefacts backend, behind CloudCLI's authenticated plugin RPC proxy. CloudCLI copies plugin
// files flat into ~/.claude-code-ui/plugins/, so this never imports repo code: it runs the `share`
// CLI (custom/share/share.mjs, linked to ~/.local/bin/share by `make share-install`).
import { execFile } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SHARE_BIN = process.env.SHARE_BIN || path.join(process.env.HOME || os.homedir(), '.local', 'bin', 'share');
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const DURATION_RE = /^\d{1,4}[mhd]$/;

function share(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SHARE_BIN, ...args], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().replace(/^share: /, '').split('\n')[0]));
      else resolve(stdout);
    });
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/artefacts' || url.pathname === '/')) {
      const groups = JSON.parse(await share(['list', '--json', '--with-sessions']));
      return send(200, { now: Date.now(), groups });
    }
    if (req.method === 'POST' && (url.pathname === '/extend' || url.pathname === '/expire')) {
      const { id, by = '24h' } = await readJson(req);
      if (typeof id !== 'string' || !ID_RE.test(id)) return send(400, { error: 'bad share id' });
      if (url.pathname === '/extend' && (typeof by !== 'string' || !DURATION_RE.test(by))) return send(400, { error: 'bad duration' });
      await share(url.pathname === '/extend' ? ['extend', id, '--by', by] : ['expire', id]);
      return send(200, { ok: true });
    }
    return send(404, { error: 'not found' });
  } catch (err) {
    return send(500, { error: err.message || String(err) });
  }
});

server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, port: server.address().port }));
});
