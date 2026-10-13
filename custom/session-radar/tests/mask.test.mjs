// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { maskSecrets } from '../mask.mjs';

// Fake secrets, assembled at run time so no key-shaped literal sits in the source.
const HEX64 = 'ab'.repeat(32);
const FAKE_TOKEN = 'tok' + 'en' + '1'.repeat(40);
const FAKE_KEY = 'sk' + '-' + 'a'.repeat(24);
const FAKE_GH = 'gh' + 'p_' + 'B'.repeat(30);
const FAKE_AKIA = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
const FAKE_JWT = 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'sigpart123';
const B64_40 = 'Zm9vYmFy' + 'QmF6cXV4' + 'MTIzNDU2Nzg5' + 'YWJjZGVmR0hp'; // letters and digits, 40 chars
const MASKED = '•••';
const SHA40 = '0123456789abcdef0123456789abcdef01234567';
const UUID = '3f2b1c0d-9a8b-4c7d-8e6f-5a4b3c2d1e0f';

describe('maskSecrets: name-based pairs', () => {
  it('masks a JSON pair whose key names a secret', () => {
    expect(maskSecrets(`{"FOO_TOKEN":"${FAKE_TOKEN}"}`)).toBe(`{"FOO_TOKEN":"${MASKED}"}`);
  });
  it('masks env-style assignments', () => {
    expect(maskSecrets(`FOO_TOKEN=${FAKE_TOKEN} node app.js`)).toBe(`FOO_TOKEN=${MASKED} node app.js`);
  });
  it('masks a quoted env assignment', () => {
    expect(maskSecrets(`DB_PASSWORD='hunter two'`)).toBe(`DB_PASSWORD='${MASKED}'`);
  });
  it('masks --api-key with a space and with =', () => {
    expect(maskSecrets(`tool --api-key ${FAKE_TOKEN} run`)).toBe(`tool --api-key ${MASKED} run`);
    expect(maskSecrets(`tool --api-key=${FAKE_TOKEN}`)).toBe(`tool --api-key=${MASKED}`);
  });
  it('masks --token=value', () => {
    expect(maskSecrets(`cli --token=${FAKE_TOKEN}`)).toBe(`cli --token=${MASKED}`);
  });
  it('masks Authorization headers, bare and in curl -H', () => {
    expect(maskSecrets(`Authorization: Bearer ${FAKE_TOKEN}`)).toBe(`Authorization: Bearer ${MASKED}`);
    expect(maskSecrets(`curl -H 'Authorization: ${FAKE_TOKEN}' https://x.test`))
      .toBe(`curl -H 'Authorization: ${MASKED}' https://x.test`);
  });
  it('keeps a variable reference and placeholders', () => {
    expect(maskSecrets('FOO_TOKEN=$FOO_TOKEN')).toBe('FOO_TOKEN=$FOO_TOKEN');
    expect(maskSecrets('{"API_KEY":"<key>"}')).toBe('{"API_KEY":"<key>"}');
  });
  it('leaves keys whose names are not secret alone', () => {
    expect(maskSecrets('--max-turns=5 NODE_ENV=production')).toBe('--max-turns=5 NODE_ENV=production');
  });
});

describe('maskSecrets: URLs', () => {
  it('masks the password in URL credentials and keeps user and host', () => {
    expect(maskSecrets('git clone https://bob:hunter2@git.test/repo.git'))
      .toBe(`git clone https://bob:${MASKED}@git.test/repo.git`);
  });
  it('masks token and key query parameters', () => {
    expect(maskSecrets(`https://api.test/x?token=${FAKE_TOKEN}&page=2`)).toBe(`https://api.test/x?token=${MASKED}&page=2`);
    expect(maskSecrets('https://api.test/x?a=1&key=abc123')).toBe(`https://api.test/x?a=1&key=${MASKED}`);
  });
});

describe('maskSecrets: known shapes', () => {
  it.each([
    ['Anthropic/OpenAI key', FAKE_KEY],
    ['GitHub token', FAKE_GH],
    ['AWS key id', FAKE_AKIA],
    ['JWT', FAKE_JWT],
  ])('masks a %s wherever it appears', (_name, secret) => {
    expect(maskSecrets(`run --flag ${secret} end`)).toBe(`run --flag ${MASKED} end`);
  });
  it('masks Bearer values', () => {
    expect(maskSecrets(`Bearer ${FAKE_TOKEN}`)).toBe(`Bearer ${MASKED}`);
  });
});

describe('maskSecrets: bare high-entropy runs', () => {
  it('masks a 64-char hex run', () => {
    expect(maskSecrets(`x ${HEX64} y`)).toBe(`x ${MASKED} y`);
  });
  it('masks a 40+ char base64-ish run with letters and digits', () => {
    expect(maskSecrets(`x ${B64_40} y`)).toBe(`x ${MASKED} y`);
  });
});

describe('maskSecrets: the leak shape', () => {
  it('masks CLOUDCLI_BROWSER_USE_MCP_TOKEN inside a claude --mcp-config argument', () => {
    const argv = '/opt/tools/claude --output-format stream-json --model claude-opus-4 '
      + `--mcp-config {"mcpServers":{"browser":{"command":"node","env":{"CLOUDCLI_BROWSER_USE_MCP_TOKEN":"${HEX64}","PORT":"3001"}}}}`;
    const out = maskSecrets(argv);
    expect(out).toContain('"CLOUDCLI_BROWSER_USE_MCP_TOKEN":"•••"');
    expect(out).toContain('"PORT":"3001"');
    expect(out).toContain('--model claude-opus-4');
    expect(out).not.toMatch(/[0-9a-f]{64}/i);
    expect(out).not.toContain(HEX64);
  });
});

describe('maskSecrets: negatives stay readable', () => {
  it.each([
    '/opt/app/custom/session-radar/server.mjs',
    'git log --oneline',
    'npx vitest run',
    `git rev-parse ${SHA40}`,
    SHA40,
    `session ${UUID}`,
    'node_modules/.bin/vitest --config custom/vitest.config.mjs',
  ])('%s', (text) => {
    expect(maskSecrets(text)).toBe(text);
  });
  it('returns empty input unchanged', () => {
    expect(maskSecrets('')).toBe('');
    expect(maskSecrets(null)).toBe(null);
  });
  it('is idempotent', () => {
    const once = maskSecrets(`--api-key ${FAKE_TOKEN} ${HEX64} https://u:pw@h.test`);
    expect(maskSecrets(once)).toBe(once);
  });
});
