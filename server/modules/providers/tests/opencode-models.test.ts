import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  loadOpenCodeModelCatalog,
  OpenCodeProviderModels,
  OPENCODE_PREDEFINED_MODELS,
  parseOpenCodeConfigText,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';

const OPENCODE_ENV_KEYS = ['OPENCODE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

test('OpenCode config parsing accepts JSONC comments and trailing commas', () => {
  // A line comment must not swallow the next line.
  assert.deepEqual(
    parseOpenCodeConfigText('{\n  // pick a provider\n  "model": "local/x"\n}'),
    { model: 'local/x' },
  );
  assert.deepEqual(
    parseOpenCodeConfigText('{ /* inline */ "model": "local/x" }'),
    { model: 'local/x' },
  );
  assert.deepEqual(
    parseOpenCodeConfigText('{\n  /* multi\n     line */\n  "a": 1\n}'),
    { a: 1 },
  );
  assert.deepEqual(
    parseOpenCodeConfigText('{ "provider": { "local": { "name": "x", }, }, "list": [1, 2, ], }'),
    { provider: { local: { name: 'x' } }, list: [1, 2] },
  );
  // A `//` inside a string value is part of the URL, not a comment.
  assert.deepEqual(
    parseOpenCodeConfigText(
      '{\n  "baseURL": "http://127.0.0.1:8090/v1", // local server\n  "note": "a \\"//\\" b, ]"\n}',
    ),
    { baseURL: 'http://127.0.0.1:8090/v1', note: 'a "//" b, ]' },
  );
  // Strict JSON still parses unchanged.
  assert.deepEqual(parseOpenCodeConfigText('{"a":[1,{"b":null}]}'), { a: [1, { b: null }] });
});

test('OpenCode config parsing returns null for invalid or non-object JSON', () => {
  assert.equal(parseOpenCodeConfigText('{ "a": 1 '), null);
  assert.equal(parseOpenCodeConfigText('{ "a": 1 // ok\n'), null);
  assert.equal(parseOpenCodeConfigText('not json'), null);
  assert.equal(parseOpenCodeConfigText('[1, 2,]'), null);
  assert.equal(parseOpenCodeConfigText(''), null);
});

/**
 * Runs one case against a throwaway OpenCode home, so the catalog the adapter
 * reports depends on the fixture rather than on the providers the machine
 * running the suite happens to be logged into.
 */
const withOpenCodeHome = async (
  setUp: (homeDir: string) => Promise<void>,
  runTest: (adapter: OpenCodeProviderModels) => Promise<void>,
): Promise<void> => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-'));
  const originalHomedir = os.homedir;
  const originalEnv = OPENCODE_ENV_KEYS.map((key) => [key, process.env[key]] as const);

  (os as any).homedir = () => homeDir;
  for (const key of OPENCODE_ENV_KEYS) {
    delete process.env[key];
  }

  try {
    await setUp(homeDir);
    await runTest(new OpenCodeProviderModels());
  } finally {
    (os as any).homedir = originalHomedir;
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(homeDir, { recursive: true, force: true });
  }
};

const writeOpenCodeAuth = async (homeDir: string, auth: Record<string, unknown>): Promise<void> => {
  const authDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, 'auth.json'), JSON.stringify(auth), 'utf8');
};

test('OpenCode exposes only the curated predefined catalog', async () => {
  await withOpenCodeHome(async () => {}, async (adapter) => {
    // Nothing readable about this install, so the picker keeps every option
    // rather than coming up empty.
    assert.deepEqual(await adapter.getSupportedModels(), OPENCODE_PREDEFINED_MODELS);
    assert.equal(
      (await adapter.getCurrentActiveModel()).model,
      OPENCODE_PREDEFINED_MODELS.DEFAULT,
    );
  });
  // OpenCode routes by `<providerID>/<modelID>`, so every option has to carry a
  // provider prefix that `opencode models --verbose` reports.
  const providerIds = new Set(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value.split('/')[0]),
  );
  assert.deepEqual([...providerIds].sort(), ['anthropic', 'opencode', 'opencode-go', 'openai'].sort());
  assert.equal(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.every((option) => /^[a-z0-9-]+\/.+/.test(option.value)),
    true,
  );
  assert.equal(
    new Set(OPENCODE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value)).size,
    OPENCODE_PREDEFINED_MODELS.OPTIONS.length,
  );
  assert.equal(OPENCODE_PREDEFINED_MODELS.DEFAULT, 'opencode/gpt-5.6-terra');
  assert.ok(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.some((option) => option.value === 'opencode/claude-opus-5'),
  );
  assert.ok(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.some((option) => option.value === 'anthropic/claude-opus-5'),
  );
  assert.ok(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.some((option) => option.value === 'openai/gpt-5.6'),
  );
  // The Go gateway carries its own provider id, so its models must be curated
  // too - a Go subscriber otherwise authenticates while the picker offers
  // nothing they can run.
  const opencodeGoOptions = OPENCODE_PREDEFINED_MODELS.OPTIONS.filter(
    (option) => option.value.startsWith('opencode-go/'),
  );
  assert.equal(opencodeGoOptions.length, 27);
  assert.ok(opencodeGoOptions.every((option) => option.description === 'OpenCode Go'));
  const glmFlash = opencodeGoOptions.find(
    (option) => option.value === 'opencode-go/glm-5.3-flash',
  );
  assert.ok(glmFlash);
  // Effort choices come from `opencode models --verbose` variants; the runtime
  // turns a selected value into `--variant`, so the values have to match the
  // CLI's exactly.
  assert.deepEqual(
    glmFlash?.effort?.values.map((value) => value.value),
    ['low', 'high', 'max'],
  );
  assert.ok(
    opencodeGoOptions
      .filter((option) => !option.effort)
      .every((option) =>
        ['glm-5.1', 'kimi-k2.6', 'kimi-k2.7-code', 'mimo-v2.5', 'mimo-v2.5-pro',
          'minimax-m2.7', 'qwen3.6-plus', 'qwen3.7-max', 'qwen3.7-plus']
          .includes(option.value.slice('opencode-go/'.length)),
      ),
  );
});

test('OpenCode offers only models the install can route to', async () => {
  // Asking for a provider the user never connected fails the whole run with
  // "Model <id> is not valid", so an OpenCode Zen model must not be offered -
  // or defaulted to - on a machine that only holds an Anthropic key.
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeAuth(homeDir, { anthropic: { type: 'api', key: 'test' } }),
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();
      const providerIds = new Set(catalog.OPTIONS.map((option) => option.value.split('/')[0]));

      assert.deepEqual([...providerIds], ['anthropic']);
      assert.ok(catalog.OPTIONS.length > 0);
      assert.equal(catalog.DEFAULT.startsWith('anthropic/'), true);
      assert.ok(catalog.OPTIONS.some((option) => option.value === catalog.DEFAULT));
      assert.equal((await adapter.getCurrentActiveModel()).model, catalog.DEFAULT);
    },
  );

  // A Go subscriber's auth store holds only `opencode-go`, so the whole catalog
  // has to resolve to Go models and the default has to move onto one of them
  // instead of the unreachable Zen default.
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeAuth(homeDir, { 'opencode-go': { type: 'api', key: 'test' } }),
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();
      const providerIds = new Set(catalog.OPTIONS.map((option) => option.value.split('/')[0]));

      assert.deepEqual([...providerIds], ['opencode-go']);
      assert.equal(catalog.OPTIONS.length, 27);
      assert.equal(catalog.DEFAULT, 'opencode-go/grok-4.6');
      assert.ok(catalog.OPTIONS.some((option) => option.value === catalog.DEFAULT));
      assert.equal((await adapter.getCurrentActiveModel()).model, catalog.DEFAULT);
    },
  );

  // The catalog default survives whenever its own provider is connected.
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeAuth(homeDir, {
      opencode: { type: 'api', key: 'test' },
      openai: { type: 'oauth' },
    }),
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();
      const providerIds = new Set(catalog.OPTIONS.map((option) => option.value.split('/')[0]));

      assert.deepEqual([...providerIds].sort(), ['opencode', 'openai'].sort());
      assert.equal(catalog.DEFAULT, OPENCODE_PREDEFINED_MODELS.DEFAULT);
    },
  );

  // Providers configured rather than logged into count too.
  await withOpenCodeHome(
    async (homeDir) => {
      const configDir = path.join(homeDir, '.config', 'opencode');
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(configDir, 'opencode.json'),
        JSON.stringify({ provider: { anthropic: { options: {} } } }),
        'utf8',
      );
    },
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();
      const providerIds = new Set(catalog.OPTIONS.map((option) => option.value.split('/')[0]));

      assert.deepEqual([...providerIds], ['anthropic']);
    },
  );

  // An API key in the environment is enough on its own.
  await withOpenCodeHome(
    async () => {
      process.env.OPENAI_API_KEY = 'test';
    },
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();
      const providerIds = new Set(catalog.OPTIONS.map((option) => option.value.split('/')[0]));

      assert.deepEqual([...providerIds], ['openai']);
    },
  );
});

test('OpenCode reads providers from a commented opencode.jsonc', async () => {
  await withOpenCodeHome(
    async (homeDir) => {
      const configDir = path.join(homeDir, '.config', 'opencode');
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(configDir, 'opencode.jsonc'),
        [
          '{',
          '  // local llama.cpp server',
          '  "provider": {',
          '    "anthropic": { "options": { "baseURL": "http://127.0.0.1:8090/v1" }, },',
          '  },',
          '}',
        ].join('\n'),
        'utf8',
      );
    },
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();
      const providerIds = new Set(catalog.OPTIONS.map((option) => option.value.split('/')[0]));

      // Only the configured provider is connected, so the curated Zen list is
      // narrowed away, which can only happen if the JSONC file was parsed.
      assert.deepEqual([...providerIds], ['anthropic']);
    },
  );
});

/** A commented opencode.jsonc declaring the two custom providers from the user's real config. */
const CUSTOM_PROVIDER_CONFIG = [
  '{',
  '  // Local llama.cpp server',
  '  "provider": {',
  '    "local": {',
  '      "name": "Local (llama.cpp)",',
  '      "npm": "@ai-sdk/openai-compatible",',
  '      "options": { "baseURL": "http://127.0.0.1:8090/v1", "apiKey": "none" },',
  '      "models": { "gemma-4-E2B-it-Q4_0.gguf": { "name": "Gemma 4 E2B (local)" } },',
  '    },',
  '    "mac-lmstudio": {',
  '      "name": "LM Studio (Mac M4, tailnet)",',
  '      "npm": "@ai-sdk/openai-compatible",',
  '      "options": { "baseURL": "http://host:11435/v1", "apiKey": "none" },',
  '      "models": {',
  '        "qwen3.8-27b-mlx": {',
  '          "name": "Qwen3.8 27B (MLX 4-bit, thinking)",',
  '          "limit": { "context": 65536, "output": 32000 },',
  '        },',
  '      },',
  '    },',
  '    "opencode": { "whitelist": ["nemotron-3-ultra-free"] },',
  '  },',
  '  "enabled_providers": ["opencode", "local", "mac-lmstudio"],',
  '}',
].join('\n');

/** Creates a throwaway home dir holding one opencode.jsonc, for injected catalog loads. */
const withConfigHome = async (
  configText: string,
  runTest: (homeDir: string) => Promise<void>,
): Promise<void> => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-config-home-'));
  try {
    const configDir = path.join(homeDir, '.config', 'opencode');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'opencode.jsonc'), configText, 'utf8');
    await runTest(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
};

test('OpenCode lists models declared under custom providers', async () => {
  await withConfigHome(CUSTOM_PROVIDER_CONFIG, async (homeDir) => {
    const catalog = await loadOpenCodeModelCatalog(homeDir);
    const byValue = new Map(catalog.OPTIONS.map((option) => [option.value, option]));

    assert.deepEqual(byValue.get('local/gemma-4-E2B-it-Q4_0.gguf'), {
      value: 'local/gemma-4-E2B-it-Q4_0.gguf',
      label: 'Gemma 4 E2B (local)',
      description: 'Local (llama.cpp)',
    });
    assert.deepEqual(byValue.get('mac-lmstudio/qwen3.8-27b-mlx'), {
      value: 'mac-lmstudio/qwen3.8-27b-mlx',
      label: 'Qwen3.8 27B (MLX 4-bit, thinking)',
      description: 'LM Studio (Mac M4, tailnet)',
    });
    // Custom models come after the curated ones, so the picker keeps the
    // catalog order for everything OpenCode ships.
    const customIndex = catalog.OPTIONS.findIndex((option) => option.value === 'local/gemma-4-E2B-it-Q4_0.gguf');
    assert.ok(customIndex > 0);
    assert.ok(catalog.OPTIONS.slice(0, customIndex).every((option) => !option.value.startsWith('local/')));
    // The default stays on the curated catalog rather than moving to a local model.
    assert.ok(catalog.OPTIONS.some((option) => option.value === catalog.DEFAULT));
  });
});

test('OpenCode keeps the curated entry when a custom model repeats its value', async () => {
  const config = JSON.stringify({
    provider: {
      anthropic: { models: { 'claude-opus-5': { name: 'Renamed locally' } } },
    },
  });
  await withConfigHome(config, async (homeDir) => {
    const catalog = await loadOpenCodeModelCatalog(homeDir);
    const matches = catalog.OPTIONS.filter((option) => option.value === 'anthropic/claude-opus-5');

    assert.equal(matches.length, 1);
    assert.equal(matches[0].label, 'Claude Opus 5');
  });
});

test('OpenCode leaves the catalog unchanged when no custom models are declared', async () => {
  await withConfigHome('{ "provider": { "local": { "options": {} } } }', async (homeDir) => {
    const catalog = await loadOpenCodeModelCatalog(homeDir);
    assert.equal(catalog.OPTIONS.some((option) => option.value.startsWith('local/')), false);
  });
});

const writeOpenCodeSessionDatabase = async (homeDir: string, rows: Array<Record<string, unknown>>) => {
  const dbPath = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db');
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY,
        model text,
        agent text,
        directory text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      );
    `);
    const insert = db.prepare(
      'INSERT INTO session (id, model, agent, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const [index, row] of rows.entries()) {
      insert.run(
        row.id,
        row.model,
        row.agent ?? null,
        row.directory ?? '/tmp/project',
        row.timeCreated ?? 1700000000000,
        row.timeUpdated ?? 1700000001000 + index,
      );
    }
  } finally {
    db.close();
  }
};

test('OpenCode composes the provider prefix into session model ids', async () => {
  // The lookup translates the app session id through the sessions database,
  // so point it at a throwaway file rather than the developer's real one.
  const tempSessionsDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-model-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempSessionsDirectory, 'auth.db');
    await initializeDatabase();
    // OpenCode stores the provider and model id in separate fields of the
    // session row ({"id":"z-ai/glm-5.3-flash","providerID":"openrouter"}), but
    // the CLI's `--model` flag only resolves the composed
    // `<providerID>/<modelID>` form. Resuming such a session without the prefix
    // fails with an unknown-model server error, which hits OpenRouter users
    // hardest because their model ids carry a slash themselves.
    await withOpenCodeHome(
      (homeDir) => writeOpenCodeSessionDatabase(homeDir, [
        {
          id: 'ses_openrouter',
          model: JSON.stringify({
            id: 'z-ai/glm-5.3-flash',
            providerID: 'openrouter',
            variant: 'default',
          }),
        },
        {
          id: 'ses_qualified',
          // An id that already carries the provider prefix must survive as-is.
          model: JSON.stringify({
            id: 'openrouter/z-ai/glm-5.3-flash',
            providerID: 'openrouter',
          }),
        },
        {
          id: 'ses_plain_string',
          model: 'opencode/gpt-5.6-terra',
        },
      ]),
      async (adapter) => {
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_openrouter')).model,
          'openrouter/z-ai/glm-5.3-flash',
        );
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_qualified')).model,
          'openrouter/z-ai/glm-5.3-flash',
        );
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_plain_string')).model,
          'opencode/gpt-5.6-terra',
        );
      },
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempSessionsDirectory, { recursive: true, force: true });
  }
});
