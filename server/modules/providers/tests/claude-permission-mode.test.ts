import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  queryClaudeSDK,
  resolveToolApproval,
  setClaudeSDKPermissionMode,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * A session's permission mode follows the user after the process started.
 *
 * Approving a plan without naming a mode drops the CLI to `default`, where
 * every edit and command asks — the user had picked auto and got prompts. The
 * approval therefore carries the mode to continue in, and a mode picked in the
 * composer while the process runs is applied to it right away instead of only
 * to the next message.
 */

const NATIVE_ID = 'native-mode-session';

type CanUseTool = (toolName: string, input: Record<string, unknown>, context: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

type Harness = {
  sent: NormalizedMessage[];
  canUseTool: CanUseTool;
  cliModes: string[];
  emit: (message: Record<string, unknown>) => void;
};

async function withProcess(
  sessionId: string,
  options: { permissionMode?: string; rejectBypass?: boolean },
  runTest: (harness: Harness) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-permission-mode-'));
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  // A holder, not a `let`: assigned inside createQuery, which TypeScript's
  // narrowing cannot see, so a plain variable reads as never-assigned.
  const captured: { canUseTool: CanUseTool | null } = { canUseTool: null };
  const cliModes: string[] = [];
  const sent: NormalizedMessage[] = [];

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options: sdkOptions }) => {
    captured.canUseTool = sdkOptions.canUseTool as CanUseTool;
    void (async () => { for await (const _message of prompt) { /* stdin */ } })();
    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();
    return Object.assign(iterator, {
      interrupt: async () => {},
      setPermissionMode: async (mode: string) => {
        if (mode === 'bypassPermissions' && options.rejectBypass) {
          throw new Error('Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions');
        }
        cliModes.push(mode);
      },
    });
  };

  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sid) => sessions.normalizeMessage(raw, sid),
    isProviderInstalled: async () => true,
    createQuery,
  };
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const emit = (message: Record<string, unknown>) => { queue.push(message); wake?.(); };
  const end = () => { queue.push(null); wake?.(); };

  const done = queryClaudeSDK('go', { sessionId, cwd, permissionMode: options.permissionMode }, writer as never, context);
  try {
    await settle();
    emit({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
    await settle();
    assert.ok(captured.canUseTool, 'the query was created with a permission callback');
    await runTest({ sent, canUseTool: captured.canUseTool, cliModes, emit });
  } finally {
    end();
    await done;
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });
const signal = () => new AbortController().signal;

/** Asks for a tool, answers the prompt it raises with `decision`, and returns the SDK verdict. */
async function answerPrompt(harness: Harness, toolName: string, decision: Record<string, unknown>) {
  const verdict = harness.canUseTool(toolName, { plan: 'do it' }, { signal: signal() });
  await settle();
  const request = harness.sent.filter((message) => message.kind === 'permission_request').at(-1) as { requestId: string } | undefined;
  assert.ok(request, `${toolName} raised a permission prompt`);
  resolveToolApproval(request.requestId, decision);
  return verdict;
}

test('approving a plan continues in the mode the user picked', async () => {
  await withProcess('app-mode-plan-exit', { permissionMode: 'plan' }, async (harness) => {
    const verdict = await answerPrompt(harness, 'ExitPlanMode', { allow: true, permissionMode: 'auto' });

    assert.equal(verdict.behavior, 'allow');
    assert.deepEqual(verdict.updatedPermissions, [{ type: 'setMode', mode: 'auto', destination: 'session' }]);
  });
});

test('approving a plan without a mode leaves the CLI to choose, as before', async () => {
  await withProcess('app-mode-plan-bare', { permissionMode: 'plan' }, async (harness) => {
    const verdict = await answerPrompt(harness, 'ExitPlanMode', { allow: true });

    assert.equal(verdict.behavior, 'allow');
    assert.equal(verdict.updatedPermissions, undefined);
  });
});

test('a mode picked while the process runs is applied to it', async () => {
  await withProcess('app-mode-live', { permissionMode: 'default' }, async (harness) => {
    assert.equal(await setClaudeSDKPermissionMode('app-mode-live', 'auto'), true);
    assert.deepEqual(harness.cliModes, ['auto']);
  });
});

test('picking a mode for a session with no live process does nothing', async () => {
  assert.equal(await setClaudeSDKPermissionMode('app-mode-none', 'auto'), false);
});

test('bypass picked mid-run is honoured even though the CLI refuses the switch', async () => {
  await withProcess('app-mode-bypass', { permissionMode: 'default', rejectBypass: true }, async (harness) => {
    assert.equal(await setClaudeSDKPermissionMode('app-mode-bypass', 'bypassPermissions'), true);

    // The CLI stays in its mode and keeps asking; the app answers for the user.
    const verdict = await harness.canUseTool('Write', { file_path: '/tmp/x', content: 'x' }, { signal: signal() });
    assert.equal(verdict.behavior, 'allow');
    assert.equal(harness.sent.filter((message) => message.kind === 'permission_request').length, 0);
  });
});

test('an unknown mode is refused', async () => {
  await withProcess('app-mode-invalid', { permissionMode: 'default' }, async (harness) => {
    assert.equal(await setClaudeSDKPermissionMode('app-mode-invalid', 'yolo'), false);
    assert.deepEqual(harness.cliModes, []);
  });
});
