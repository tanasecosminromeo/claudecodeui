import assert from 'node:assert/strict';
import test from 'node:test';

import { maskSecrets } from '@/shared/secret-masking.js';

const MASK = '••••';
// Fake tokens are built at runtime so no token-shaped literal is committed.
const fakeGithub = (prefix: string) => prefix + 'A'.repeat(36);
const FAKE_JWT = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJlMTIz'].join('.');
const FAKE_PEM_BODY = ['MIIEFAKEBODYLINE1', 'MIIEFAKEBODYLINE2', 'FAKEtrailingLINE='].join('\n');
// PEM header lines are built at runtime so no key-shaped literal is committed.
const pemLine = (word: string, kind = ' PRIVATE KEY') => '-----' + word + kind + '-----';
const FAKE_PEM = [pemLine('BEGIN RSA'), FAKE_PEM_BODY, pemLine('END RSA')].join('\n');

test('a PEM private key keeps its BEGIN and END lines and loses the body', () => {
  const masked = maskSecrets(`before\n${FAKE_PEM}\nafter`);
  assert.equal(masked, `before\n${pemLine('BEGIN RSA')} ${MASK} ${pemLine('END RSA')}\nafter`);
  assert.ok(!masked.includes('FAKEBODY'));
});

test('an unnamed PEM private key block is masked too', () => {
  const masked = maskSecrets(`${pemLine('BEGIN')}\nFAKEBODY\n${pemLine('END')}`);
  assert.equal(masked, `${pemLine('BEGIN')} ${MASK} ${pemLine('END')}`);
});

test('known token shapes are replaced whole', () => {
  const cases: Array<[string, string]> = [
    ['key sk-ant-' + 'api03-' + 'Z'.repeat(40), 'key ••••'],
    ['sk-' + 'b'.repeat(24), '••••'],
    [fakeGithub('ghp_'), '••••'],
    [fakeGithub('gho_'), '••••'],
    [fakeGithub('ghu_'), '••••'],
    [fakeGithub('ghs_'), '••••'],
    [fakeGithub('ghr_'), '••••'],
    ['github_pat_' + 'C'.repeat(60), '••••'],
    ['glpat-' + 'D'.repeat(20), '••••'],
    ['xoxb-' + '1234567890-abcdefghij', '••••'],
    ['xoxp-' + '1234567890-abcdefghij', '••••'],
    ['AKIA' + 'EXAMPLE012345678', '••••'],
    ['AIza' + 'E'.repeat(35), '••••'],
    ['npm_' + 'F'.repeat(36), '••••'],
    [FAKE_JWT, '••••'],
    ['Authorization: Bearer ' + 'G'.repeat(24), 'Authorization: Bearer ••••'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(maskSecrets(input), expected, input.slice(0, 12));
  }
});

test('assignments keep the name and separator and mask the value', () => {
  assert.equal(maskSecrets('API_KEY=FAKE_TEST_VALUE_not_a_real_key'), `API_KEY=${MASK}`);
  assert.equal(maskSecrets('export DB_PASSWORD=hunter2'), `export DB_PASSWORD=${MASK}`);
  assert.equal(maskSecrets('GITHUB_TOKEN: "FAKE_TEST_VALUE"'), `GITHUB_TOKEN: "${MASK}"`);
  assert.equal(maskSecrets("client_secret='FAKE_TEST_VALUE_123'"), `client_secret='${MASK}'`);
  assert.equal(maskSecrets('{"apiKey": "FAKE_TEST_VALUE_123"}'), `{"apiKey": "${MASK}"}`);
  assert.equal(maskSecrets('password: hunter2'), `password: ${MASK}`);
  assert.equal(maskSecrets('MY_CREDENTIALS=abc123'), `MY_CREDENTIALS=${MASK}`);
  assert.equal(maskSecrets('AUTH_HEADER_SECRET = xyz789'), `AUTH_HEADER_SECRET = ${MASK}`);
  assert.equal(maskSecrets('private_key: FAKE_TEST_VALUE_123'), `private_key: ${MASK}`);
  assert.equal(maskSecrets('NPM_PWD=FAKE_TEST_VALUE'), `NPM_PWD=${MASK}`);
  assert.equal(maskSecrets('BASE64_KEY=abc123=='), `BASE64_KEY=${MASK}`);
});

test('an assignment inside another line or a quoted value is still masked', () => {
  assert.equal(maskSecrets('Set the variable: API_KEY=FAKE_TEST_VALUE in the file.'), `Set the variable: API_KEY=${MASK} in the file.`);
  assert.equal(maskSecrets('note: "API_KEY=FAKE_TEST_VALUE"'), `note: "API_KEY=${MASK}"`);
});

test('empty, placeholder and already-masked values are left alone', () => {
  const unchanged = [
    'API_KEY=',
    'API_KEY=""',
    'API_KEY=${API_KEY}',
    'API_KEY=$API_KEY',
    'API_KEY=<your-key>',
    'password: "***"',
    `API_KEY=${MASK}`,
  ];
  for (const line of unchanged) {
    assert.equal(maskSecrets(line), line, line);
  }
});

test('credentials in a URL keep the user and host', () => {
  assert.equal(
    maskSecrets('git clone https://octocat:FAKE_TEST_VALUE@example.com/repo.git'),
    `git clone https://octocat:${MASK}@example.com/repo.git`,
  );
});

test('a key in a URL query string or fragment is not masked', () => {
  // Credential-shaped values are built at runtime so no key-shaped literal is committed.
  const plain = 'abc123' + 'def456';
  const tokenish = 'a1b2c3' + 'd4e5';
  const links = [
    `open http://example-claude-companion.srv:53996/?key=${plain} now`,
    `open http://h/?a=1&token=${tokenish} now`,
    'open https://h/?api_key=' + 'Zq9xW2' + 'vB7nR4tY8u now',
    `open https://h/page#token=${tokenish} now`,
    `[link](http://h/?key=${plain})`,
    `**http://h/?key=${plain}**`,
  ];
  for (const line of links) {
    assert.equal(maskSecrets(line), line, line);
  }
});

test('a known token shape inside a URL is masked and the rest of the URL is kept', () => {
  const googleKey = 'AIza' + 'E'.repeat(35);
  const openaiKey = 'sk-' + 'b'.repeat(24);
  const githubKey = fakeGithub('ghp_');
  assert.equal(maskSecrets(`https://h/?key=${googleKey}&x=1`), `https://h/?key=${MASK}&x=1`);
  assert.equal(maskSecrets(`https://h/?token=${openaiKey}`), `https://h/?token=${MASK}`);
  assert.equal(maskSecrets(`https://h/?access_token=${FAKE_JWT}`), `https://h/?access_token=${MASK}`);
  assert.equal(maskSecrets(`https://h/?t=${githubKey}`), `https://h/?t=${MASK}`);
});

test('a URL password is hidden and assignments outside the URL are still masked', () => {
  assert.equal(
    maskSecrets('git clone https://octocat:FAKE_TEST_VALUE@example.com/repo.git API_KEY=' + 'abc123' + 'def456'),
    `git clone https://octocat:${MASK}@example.com/repo.git API_KEY=${MASK}`,
  );
});

test('masking a URL with a key in its query string twice changes nothing more', () => {
  const plain = 'abc123' + 'def456';
  const sample = `open http://h/?key=${plain} and https://h/?token=sk-` + 'b'.repeat(24) + ' now';
  const once = maskSecrets(sample);
  assert.equal(once, `open http://h/?key=${plain} and https://h/?token=${MASK} now`);
  assert.equal(maskSecrets(once), once);
});

test('ordinary text, code, hashes and identifiers stay identical', () => {
  const ordinary = [
    'const token = getToken();',
    'const password_reset_url = "https://example.com/reset";',
    'password_reset_url',
    'KEY_FILE_EXTENSION = /\\.(pem|key|p12)$/i',
    'if (token === undefined) return;',
    'max_tokens=4096',
    'token: string;',
    'token = process.env.TOKEN',
    'keyboard: qwerty',
    'risk-assessment-framework-long-name-here',
    'commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39',
    'session 9b1e4c2a-7d3f-4e5a-8b6c-1d2e3f4a5b6c',
    'see src/app.ts',
    'const x = "hello world"; // ok',
  ];
  for (const line of ordinary) {
    assert.equal(maskSecrets(line), line, line);
  }
});

test('masking twice is the same as masking once', () => {
  const samples = [
    `${FAKE_PEM}\nAPI_KEY=FAKE_TEST_VALUE\n"apiKey": "FAKE_TEST_VALUE"`,
    `token ${FAKE_JWT} and sk-${'c'.repeat(30)} and https://u:p@h.example`,
    'Authorization: Bearer ' + 'G'.repeat(24),
  ];
  for (const sample of samples) {
    const once = maskSecrets(sample);
    assert.equal(maskSecrets(once), once, sample.slice(0, 20));
  }
});

test('empty input is returned as is', () => {
  assert.equal(maskSecrets(''), '');
});

// Measured on this repository before the rule was narrowed: 23% of its source
// files opened masked and read-only because of lines like these.
test('labels, storage keys and translations with secret-sounding names stay visible', () => {
  for (const line of [
    '"password": "Password",',
    '"changePassword": "Change password",',
    "const AUTH_TOKEN_STORAGE_KEY = 'auth-token';",
    "const STORAGE_KEY = 'claude-ui-theme';",
    "{ id: 'html', labelKey: 'settings.html', descriptionKey: 'settings.htmlHint' },",
    'compact: { phase: "done", preTokens: 1234, postTokens: 567 },',
    'key: index,',
    'apiKey: apiKeyFromEnv,',
    'Environment Variables (KEY=value, one per line)',
    'TOKEN=your-token',
  ]) {
    assert.equal(maskSecrets(line), line, line);
  }
});

test('env files, compose and MCP env maps mask any real value', () => {
  assert.equal(maskSecrets('DB_PASSWORD=FAKEpassword'), `DB_PASSWORD=${MASK}`);
  assert.equal(maskSecrets('export API_KEY="FAKEvalue"'), `export API_KEY="${MASK}"`);
  assert.equal(maskSecrets('  GITHUB_TOKEN: FAKEvalue'), `  GITHUB_TOKEN: ${MASK}`);
  assert.equal(maskSecrets('"BRAVE_API_KEY": "FAKEvalue"'), `"BRAVE_API_KEY": "${MASK}"`);
});

test('a value inside an HTML element is masked; a generic type is not', () => {
  assert.equal(maskSecrets('<td>API_KEY=FAKE_TEST_VALUE_123</td>'), `<td>API_KEY=${MASK}</td>`);
  assert.equal(maskSecrets('let token: Promise<string>;'), 'let token: Promise<string>;');
});
