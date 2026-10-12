import assert from 'node:assert/strict';
import test from 'node:test';

import { hideProtectedPatchSections, refuseProtectedFile } from '@/modules/git/git-protected-files.js';

const FAKE = 'FAKE_TEST_VALUE_not_a_real_key';
const PATCH = [
  'commit 1234567',
  'Author: Someone <someone@example.com>',
  '',
  '    add config',
  '',
  'diff --git a/.env b/.env',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/.env',
  '@@ -0,0 +1 @@',
  `+API_TOKEN=${FAKE}`,
  'diff --git a/src/app.ts b/src/app.ts',
  'index 2222222..3333333 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/keys/release.jks b/keys/release.jks',
  'new file mode 100644',
  'index 0000000..4444444',
  'Binary files /dev/null and b/keys/release.jks differ',
  '',
].join('\n');

test('a commit patch keeps protected files named but hides their changes', () => {
  const visible = hideProtectedPatchSections(PATCH, '/srv/repo', '/users/someone');
  assert.equal(visible.includes(FAKE), false);
  assert.match(visible, /diff --git a\/\.env b\/\.env\n(?:.*\n)*?\(Protected: may contain keys\. Contents hidden\.\)/);
  assert.match(visible, /diff --git a\/keys\/release\.jks b\/keys\/release\.jks\n(?:.*\n)*?\(Protected: may contain keys\. Contents hidden\.\)/);
  // Other files and the commit header are untouched.
  assert.match(visible, /^commit 1234567\n/);
  assert.match(visible, /\+\+\+ b\/src\/app\.ts\n@@ -1 \+1 @@\n-old\n\+new\n/);
});

test('a patch with no protected file comes back unchanged', () => {
  const plain = 'diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-a\n+b\n';
  assert.equal(hideProtectedPatchSections(plain, '/srv/repo', '/users/someone'), plain);
});

test('a single protected file is refused with 403 PROTECTED_FILE', () => {
  const calls: Array<{ status?: number; body?: unknown }> = [];
  const res = {
    status(code: number) { calls.push({ status: code }); return this; },
    json(body: unknown) { calls[calls.length - 1].body = body; return this; },
  };
  assert.equal(refuseProtectedFile(res as never, '/srv/repo', 'config/.env.local', '/users/someone'), true);
  assert.deepEqual(calls, [{ status: 403, body: { error: 'Protected: may contain keys. Contents hidden.', code: 'PROTECTED_FILE' } }]);
  assert.equal(refuseProtectedFile(res as never, '/srv/repo', 'src/load-env.ts', '/users/someone'), false);
  assert.equal(calls.length, 1);
});
