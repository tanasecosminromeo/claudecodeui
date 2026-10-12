import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  getOpenCodeDatabasePath,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/**
 * Curated OpenCode catalog shipped as immutable CloudCLI defaults.
 *
 * OpenCode routes by `<providerID>/<modelID>`, so this list mirrors the
 * providers `opencode models --verbose` reports: the OpenCode Zen gateway, the
 * OpenCode Go subscription gateway, and the Anthropic and OpenAI providers
 * OpenCode can address directly with the user's own credentials.
 */
export const OPENCODE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'opencode/gpt-5.6-sol', label: 'GPT 5.6 Sol', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.6-terra', label: 'GPT 5.6 Terra', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.6-luna', label: 'GPT 5.6 Luna', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.5', label: 'GPT 5.5', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.5-pro', label: 'GPT 5.5 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4', label: 'GPT 5.4', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4-pro', label: 'GPT 5.4 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4-mini', label: 'GPT 5.4 Mini', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.4-nano', label: 'GPT 5.4 Nano', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.3-codex', label: 'GPT 5.3 Codex', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.3-codex-spark', label: 'GPT 5.3 Codex Spark', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.2', label: 'GPT 5.2', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5.1', label: 'GPT 5.1', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5', label: 'GPT 5', description: 'OpenCode Zen' },
    { value: 'opencode/gpt-5-nano', label: 'GPT 5 Nano', description: 'OpenCode Zen' },
    { value: 'opencode/claude-fable-5', label: 'Claude Fable 5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-5', label: 'Claude Opus 5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-8', label: 'Claude Opus 4.8', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-7', label: 'Claude Opus 4.7', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-6', label: 'Claude Opus 4.6', description: 'OpenCode Zen' },
    { value: 'opencode/claude-opus-4-5', label: 'Claude Opus 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-5', label: 'Claude Sonnet 5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'OpenCode Zen' },
    { value: 'opencode/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.6-flash', label: 'Gemini 3.6 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.5-flash', label: 'Gemini 3.5 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3.1-pro', label: 'Gemini 3.1 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/gemini-3-flash', label: 'Gemini 3 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/grok-4.5', label: 'Grok 4.5', description: 'OpenCode Zen' },
    { value: 'opencode/grok-build-0.1', label: 'Grok Build 0.1', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.7-max', label: 'Qwen3.7 Max', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.7-plus', label: 'Qwen3.7 Plus', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.6-plus', label: 'Qwen3.6 Plus', description: 'OpenCode Zen' },
    { value: 'opencode/qwen3.5-plus', label: 'Qwen3.5 Plus', description: 'OpenCode Zen' },
    { value: 'opencode/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'OpenCode Zen' },
    { value: 'opencode/deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'OpenCode Zen' },
    { value: 'opencode/minimax-m3', label: 'MiniMax M3', description: 'OpenCode Zen' },
    { value: 'opencode/minimax-m2.7', label: 'MiniMax M2.7', description: 'OpenCode Zen' },
    { value: 'opencode/minimax-m2.5', label: 'MiniMax M2.5', description: 'OpenCode Zen' },
    { value: 'opencode/glm-5.2', label: 'GLM 5.2', description: 'OpenCode Zen' },
    { value: 'opencode/glm-5.1', label: 'GLM 5.1', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k2.5', label: 'Kimi K2.5', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k2.6', label: 'Kimi K2.6', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k2.7-code', label: 'Kimi K2.7 Code', description: 'OpenCode Zen' },
    { value: 'opencode/kimi-k3', label: 'Kimi K3', description: 'OpenCode Zen' },
    { value: 'opencode/big-pickle', label: 'Big Pickle', description: 'OpenCode Zen · Free' },
    { value: 'opencode/mimo-v2.5-free', label: 'MiMo-V2.5 Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/laguna-s-2.1-free', label: 'Laguna S 2.1 Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/ling-3.0-flash-free', label: 'Ling-3.0-flash Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/north-mini-code-free', label: 'North Mini Code Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/nemotron-3-ultra-free', label: 'Nemotron 3 Ultra Free', description: 'OpenCode Zen · Free' },
    { value: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free', description: 'OpenCode Zen · Free' },
    {
      value: 'opencode-go/grok-4.6',
      label: 'Grok 4.6',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'opencode-go/glm-5.3-flash',
      label: 'GLM 5.3 Flash',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/glm-5.3',
      label: 'GLM 5.3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/glm-5.2',
      label: 'GLM 5.2',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'high' }, { value: 'max' }],
      },
    },
    { value: 'opencode-go/glm-5.1', label: 'GLM 5.1', description: 'OpenCode Go' },
    {
      value: 'opencode-go/gpt-5.6-luna',
      label: 'GPT 5.6 Luna',
      description: 'OpenCode Go',
      effort: {
        values: [
          { value: 'none' },
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opencode-go/kimi-k3',
      label: 'Kimi K3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'max' }],
      },
    },
    { value: 'opencode-go/kimi-k2.7-code', label: 'Kimi K2.7 Code', description: 'OpenCode Go' },
    { value: 'opencode-go/kimi-k2.6', label: 'Kimi K2.6', description: 'OpenCode Go' },
    {
      value: 'opencode-go/longcat-2.0',
      label: 'LongCat 2.0',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      },
    },
    { value: 'opencode-go/mimo-v2.5', label: 'MiMo V2.5', description: 'OpenCode Go' },
    { value: 'opencode-go/mimo-v2.5-pro', label: 'MiMo V2.5 Pro', description: 'OpenCode Go' },
    {
      value: 'opencode-go/minimax-m3',
      label: 'MiniMax M3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'none' }, { value: 'thinking' }],
      },
    },
    { value: 'opencode-go/minimax-m2.7', label: 'MiniMax M2.7', description: 'OpenCode Go' },
    {
      value: 'opencode-go/muse-spark-1.3-contributor',
      label: 'Muse Spark 1.3 Contributor',
      description: 'OpenCode Go',
      effort: {
        values: [
          { value: 'minimal' },
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
        ],
      },
    },
    {
      value: 'opencode-go/muse-spark-1.2-contributor',
      label: 'Muse Spark 1.2 Contributor',
      description: 'OpenCode Go',
      effort: {
        values: [
          { value: 'minimal' },
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
        ],
      },
    },
    {
      value: 'opencode-go/qwen3.8-max',
      label: 'Qwen3.8 Max',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'opencode-go/qwen3.8-flash',
      label: 'Qwen3.8 Flash',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'xhigh' }],
      },
    },
    { value: 'opencode-go/qwen3.7-max', label: 'Qwen3.7 Max', description: 'OpenCode Go' },
    { value: 'opencode-go/qwen3.7-plus', label: 'Qwen3.7 Plus', description: 'OpenCode Go' },
    { value: 'opencode-go/qwen3.6-plus', label: 'Qwen3.6 Plus', description: 'OpenCode Go' },
    {
      value: 'opencode-go/deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/deepseek-v4-flash-vision-exp',
      label: 'DeepSeek V4 Flash Vision Exp',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
    {
      value: 'opencode-go/hy4-preview',
      label: 'Hy4 Preview',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'none' }, { value: 'high' }],
      },
    },
    {
      value: 'opencode-go/hy3',
      label: 'Hy3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'none' }, { value: 'low' }, { value: 'high' }],
      },
    },
    {
      value: 'opencode-go/omen-alpha',
      label: 'Omen Alpha',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }],
      },
    },
    { value: 'anthropic/claude-opus-5', label: 'Claude Opus 5', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-5-fast', label: 'Claude Opus 5 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-fable-5', label: 'Claude Fable 5', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-8-fast', label: 'Claude Opus 4.8 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-7-fast', label: 'Claude Opus 4.7 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-6-fast', label: 'Claude Opus 4.6 Fast', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5 (latest)', description: 'Anthropic' },
    { value: 'anthropic/claude-opus-4-5-20251101', label: 'Claude Opus 4.5', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (latest)', description: 'Anthropic' },
    { value: 'anthropic/claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', description: 'Anthropic' },
    { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5 (latest)', description: 'Anthropic' },
    { value: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', description: 'Anthropic' },
    { value: 'openai/gpt-5.6', label: 'GPT-5.6', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-fast', label: 'GPT-5.6 Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-pro', label: 'GPT-5.6 Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-sol-fast', label: 'GPT-5.6 Sol Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-sol-pro', label: 'GPT-5.6 Sol Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-terra-fast', label: 'GPT-5.6 Terra Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-terra-pro', label: 'GPT-5.6 Terra Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-luna-fast', label: 'GPT-5.6 Luna Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.6-luna-pro', label: 'GPT-5.6 Luna Pro', description: 'OpenAI' },
    { value: 'openai/gpt-5.5', label: 'GPT-5.5', description: 'OpenAI' },
    { value: 'openai/gpt-5.5-fast', label: 'GPT-5.5 Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.4', label: 'GPT-5.4', description: 'OpenAI' },
    { value: 'openai/gpt-5.4-fast', label: 'GPT-5.4 Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'OpenAI' },
    { value: 'openai/gpt-5.4-mini-fast', label: 'GPT-5.4 mini Fast', description: 'OpenAI' },
    { value: 'openai/gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', description: 'OpenAI' },
  ],
  DEFAULT: 'opencode/gpt-5.6-terra',
};

/** Global OpenCode config files, in the order the CLI loads them. */
const OPENCODE_CONFIG_FILES = ['config.json', 'opencode.json', 'opencode.jsonc'];

/** Provider API keys OpenCode reads straight from the environment. */
const OPENCODE_ENV_PROVIDER_IDS: Record<string, string> = {
  OPENCODE_API_KEY: 'opencode',
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
};

/**
 * Blanks out `//` and block comments, leaving string literals untouched.
 *
 * OpenCode reads `opencode.jsonc`, which allows comments, so a plain
 * JSON.parse would drop the whole file. Strings are scanned as units so a
 * `//` inside a value such as "http://127.0.0.1:8090/v1" survives.
 */
const stripJsonComments = (text: string): string => {
  let output = '';
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      output += char;
      if (char === '\\') {
        output += text[index + 1] ?? '';
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === '/' && text[index + 1] === '/') {
      // Stop before the newline so the line break itself is kept.
      while (index + 1 < text.length && text[index + 1] !== '\n') {
        index += 1;
      }
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 1;
    } else {
      output += char;
    }
  }

  return output;
};

/**
 * Drops commas that directly precede `}` or `]`, which JSONC permits and
 * JSON.parse rejects. Runs after {@link stripJsonComments}, so only whitespace
 * needs skipping to reach the closing bracket.
 */
const stripTrailingCommas = (text: string): string => {
  let output = '';
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      output += char;
      if (char === '\\') {
        output += text[index + 1] ?? '';
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === ',') {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) {
        next += 1;
      }
      if (text[next] === '}' || text[next] === ']') {
        continue;
      }
    }
    output += char;
  }

  return output;
};

/**
 * Parses an OpenCode config document that may be strict JSON or JSONC.
 * Returns null when the text is still not a JSON object after cleanup.
 */
export const parseOpenCodeConfigText = (text: string): Record<string, unknown> | null => {
  try {
    return readObjectRecord(JSON.parse(stripTrailingCommas(stripJsonComments(text))));
  } catch {
    return null;
  }
};

const readOpenCodeJsonFile = async (filePath: string): Promise<Record<string, unknown> | null> => {
  try {
    return parseOpenCodeConfigText(await readFile(filePath, 'utf8'));
  } catch {
    // A missing or unreadable file contributes nothing; the auth store is the
    // authoritative source below.
    return null;
  }
};

/**
 * Lists the upstream providers this OpenCode install can actually route to.
 *
 * OpenCode resolves `<providerID>/<modelID>` against the providers the user has
 * connected, and rejects anything else outright - `Model
 * opencode/claude-sonnet-4-6 is not valid` is what a run gets for asking for an
 * OpenCode Zen model on a machine that only has an Anthropic key. The curated
 * catalog spans every provider OpenCode can address, so it has to be narrowed
 * to this machine's providers before it reaches the model picker.
 *
 * Returns null when nothing can be read, so the caller keeps the full catalog
 * rather than leaving the picker empty. Providers declared only in a
 * project-level `opencode.json` are not visible here; the null fallback and the
 * env-key sweep keep those installs on the full list.
 */
const readConnectedOpenCodeProviderIds = async (
  homeDir: string,
  configs: Record<string, unknown>[],
): Promise<Set<string> | null> => {
  const providerIds = new Set<string>();

  const auth = await readOpenCodeJsonFile(
    path.join(homeDir, '.local', 'share', 'opencode', 'auth.json'),
  );
  for (const [providerId, credential] of Object.entries(auth ?? {})) {
    if (readObjectRecord(credential)) {
      providerIds.add(providerId);
    }
  }

  for (const config of configs) {
    for (const providerId of Object.keys(readObjectRecord(config.provider) ?? {})) {
      providerIds.add(providerId);
    }
  }

  for (const [envKey, providerId] of Object.entries(OPENCODE_ENV_PROVIDER_IDS)) {
    if (readOptionalString(process.env[envKey])) {
      providerIds.add(providerId);
    }
  }

  return providerIds.size > 0 ? providerIds : null;
};

/**
 * Narrows the curated catalog to the providers OpenCode can route to.
 *
 * The default has to move with the list: leaving it on an OpenCode Zen model
 * would hand every new session a model the CLI refuses to run.
 */
const filterOpenCodeModelsByProvider = (
  definition: ProviderModelsDefinition,
  connectedProviderIds: Set<string> | null,
): ProviderModelsDefinition => {
  if (!connectedProviderIds) {
    return definition;
  }

  const options = definition.OPTIONS.filter(
    (option) => connectedProviderIds.has(option.value.split('/')[0]),
  );
  if (options.length === 0) {
    return definition;
  }

  return {
    ...definition,
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === definition.DEFAULT)
      ? definition.DEFAULT
      : options[0].value,
  };
};

/** Reads every global config file that exists, in the order the CLI loads them. */
const readOpenCodeConfigs = async (homeDir: string): Promise<Record<string, unknown>[]> => {
  const configDir = path.join(homeDir, '.config', 'opencode');
  const configs: Record<string, unknown>[] = [];

  for (const configFile of OPENCODE_CONFIG_FILES) {
    const config = await readOpenCodeJsonFile(path.join(configDir, configFile));
    if (config) {
      configs.push(config);
    }
  }

  return configs;
};

/**
 * Builds picker options for models a user declared under `provider.<id>.models`,
 * such as a local llama.cpp or LM Studio server.
 *
 * OpenCode addresses these as `<providerId>/<modelId>`, the same form the
 * curated catalog uses, so the value is exactly what the CLI expects. The
 * provider's display name becomes the description, matching how the curated
 * options name their gateway.
 */
const buildCustomProviderModelOptions = (
  configs: Record<string, unknown>[],
): ProviderModelsDefinition['OPTIONS'] => {
  const options: ProviderModelsDefinition['OPTIONS'] = [];

  for (const config of configs) {
    for (const [providerId, rawProvider] of Object.entries(readObjectRecord(config.provider) ?? {})) {
      const provider = readObjectRecord(rawProvider);
      const providerName = readOptionalString(provider?.name) ?? providerId;

      for (const [modelId, rawModel] of Object.entries(readObjectRecord(provider?.models) ?? {})) {
        const model = readObjectRecord(rawModel);
        options.push({
          value: `${providerId}/${modelId}`,
          label: readOptionalString(model?.name) ?? modelId,
          description: providerName,
        });
      }
    }
  }

  return options;
};

/**
 * Appends custom-provider models after the curated options.
 *
 * Curated entries win on a repeated `value`, so a user who declares a model
 * that already exists in the catalog does not see it twice.
 */
const appendCustomProviderModels = (
  definition: ProviderModelsDefinition,
  configs: Record<string, unknown>[],
): ProviderModelsDefinition => {
  const customOptions = buildCustomProviderModelOptions(configs);
  if (customOptions.length === 0) {
    return definition;
  }

  const seenValues = new Set(definition.OPTIONS.map((option) => option.value));
  const options = [...definition.OPTIONS];
  for (const option of customOptions) {
    if (!seenValues.has(option.value)) {
      seenValues.add(option.value);
      options.push(option);
    }
  }

  return { ...definition, OPTIONS: options };
};

const readStringList = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((item): item is string => typeof item === 'string');
};

/** `<providerId>/<modelId>` split at the first slash; provider ids never contain one. */
const providerIdOf = (value: string): string => value.split('/')[0];

/** Model id after the provider prefix. Model ids may contain slashes, e.g. OpenRouter ids. */
const modelIdOf = (value: string): string => value.slice(providerIdOf(value).length + 1);

/** Whitelist and blacklist for one provider id, merged across config files. */
type ProviderModelListRule = {
  name: string | null;
  whitelist: Set<string> | null;
  blacklist: Set<string>;
};

/**
 * Reads `provider.<id>.whitelist` and `provider.<id>.blacklist` from every
 * config. A later file wins for each key it sets, as it does when OpenCode
 * merges its config layers.
 */
const readProviderModelListRules = (
  configs: Record<string, unknown>[],
): Map<string, ProviderModelListRule> => {
  const rules = new Map<string, ProviderModelListRule>();

  for (const config of configs) {
    for (const [providerId, rawProvider] of Object.entries(readObjectRecord(config.provider) ?? {})) {
      const provider = readObjectRecord(rawProvider);
      const whitelist = readStringList(provider?.whitelist);
      const blacklist = readStringList(provider?.blacklist);
      const name = readOptionalString(provider?.name);
      if (!whitelist && !blacklist && !name) {
        continue;
      }

      const rule = rules.get(providerId) ?? { name: null, whitelist: null, blacklist: new Set<string>() };
      if (name) {
        rule.name = name;
      }
      if (whitelist) {
        rule.whitelist = new Set(whitelist);
      }
      if (blacklist) {
        rule.blacklist = new Set(blacklist);
      }
      rules.set(providerId, rule);
    }
  }

  return rules;
};

/**
 * Applies per-provider `whitelist` and `blacklist` to curated and custom options.
 *
 * A whitelist keeps only the listed model ids of that provider. It also adds
 * listed ids the catalog does not know yet (for example a newly released free
 * model), labelled with the id itself, so the picker offers what the config
 * allows rather than only what this CloudCLI release ships. A blacklist removes
 * model ids of that provider, and also stops a whitelisted id from being added.
 *
 * Without these lists the picker would show every model of a provider the user
 * has connected, including paid ones they have excluded in their config.
 *
 * When the rules would leave nothing, the input list is returned unchanged so
 * the picker is never empty.
 */
const applyProviderModelListRules = (
  definition: ProviderModelsDefinition,
  configs: Record<string, unknown>[],
): ProviderModelsDefinition => {
  const rules = readProviderModelListRules(configs);
  if (rules.size === 0) {
    return definition;
  }

  // Added options borrow the curated description of their provider when the
  // config gives no provider name, e.g. "OpenCode Zen" for `opencode/*`.
  const descriptionByProvider = new Map<string, string>();
  for (const option of definition.OPTIONS) {
    const providerId = providerIdOf(option.value);
    if (option.description && !descriptionByProvider.has(providerId)) {
      descriptionByProvider.set(providerId, option.description);
    }
  }

  const options = definition.OPTIONS.filter((option) => {
    const rule = rules.get(providerIdOf(option.value));
    if (!rule) {
      return true;
    }
    const modelId = modelIdOf(option.value);
    return !rule.blacklist.has(modelId) && (!rule.whitelist || rule.whitelist.has(modelId));
  });

  const presentValues = new Set(options.map((option) => option.value));
  for (const [providerId, rule] of rules) {
    if (!rule.whitelist) {
      continue;
    }
    for (const modelId of rule.whitelist) {
      const value = `${providerId}/${modelId}`;
      if (rule.blacklist.has(modelId) || presentValues.has(value)) {
        continue;
      }
      presentValues.add(value);
      options.push({
        value,
        label: modelId,
        description: rule.name ?? descriptionByProvider.get(providerId) ?? providerId,
      });
    }
  }

  if (options.length === 0) {
    return definition;
  }

  return {
    ...definition,
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === definition.DEFAULT)
      ? definition.DEFAULT
      : options[0].value,
  };
};

/**
 * Keeps only the options OpenCode would actually route to under the config's
 * `enabled_providers` and `disabled_providers` lists.
 *
 * OpenCode routes only to providers in `enabled_providers` when that key is
 * present, and never to one in `disabled_providers`, so a model the picker
 * offers from an excluded provider would fail the run with "not valid". Later
 * config files win for a key they set, as they do when OpenCode merges its
 * config layers.
 *
 * When the rules would leave nothing, the input list is returned unchanged. An
 * empty picker is worse than a longer one: the frontend keeps `DEFAULT: ''` as
 * the selected model, sends it with the next run, and hides the model menu
 * entirely because there is nothing to choose from.
 */
const applyProviderAccessRules = (
  definition: ProviderModelsDefinition,
  configs: Record<string, unknown>[],
): ProviderModelsDefinition => {
  let enabledProviderIds: Set<string> | null = null;
  let disabledProviderIds = new Set<string>();
  for (const config of configs) {
    const enabledList = readStringList(config.enabled_providers);
    if (enabledList) {
      enabledProviderIds = new Set(enabledList);
    }
    const disabledList = readStringList(config.disabled_providers);
    if (disabledList) {
      disabledProviderIds = new Set(disabledList);
    }
  }

  if (!enabledProviderIds && disabledProviderIds.size === 0) {
    return definition;
  }

  const options = definition.OPTIONS.filter((option) => {
    const providerId = providerIdOf(option.value);
    return (!enabledProviderIds || enabledProviderIds.has(providerId))
      && !disabledProviderIds.has(providerId);
  });
  if (options.length === 0) {
    return definition;
  }

  return {
    ...definition,
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === definition.DEFAULT)
      ? definition.DEFAULT
      : options[0].value,
  };
};

/**
 * Makes the config's top-level `model` the picker default when it is one of the
 * final options, since that is the model OpenCode itself starts with. A later
 * config file wins. When the configured model is absent from the list, the
 * default chosen by the earlier steps (curated default if it survives, else the
 * first option) stays in place.
 */
const applyConfiguredModelDefault = (
  definition: ProviderModelsDefinition,
  configs: Record<string, unknown>[],
): ProviderModelsDefinition => {
  let configuredModel: string | null = null;
  for (const config of configs) {
    configuredModel = readOptionalString(config.model) ?? configuredModel;
  }

  if (configuredModel && definition.OPTIONS.some((option) => option.value === configuredModel)) {
    return { ...definition, DEFAULT: configuredModel };
  }
  return definition;
};

/**
 * Builds the model picker catalog for the OpenCode config under `homeDir`.
 *
 * Takes the home directory as a parameter so tests can point it at a fixture
 * instead of replacing `os.homedir` for the whole process.
 */
export const loadOpenCodeModelCatalog = async (
  homeDir: string = os.homedir(),
): Promise<ProviderModelsDefinition> => {
  const configs = await readOpenCodeConfigs(homeDir);
  const connectedProviderIds = await readConnectedOpenCodeProviderIds(homeDir, configs);
  const curated = filterOpenCodeModelsByProvider(OPENCODE_PREDEFINED_MODELS, connectedProviderIds);
  const withCustomModels = appendCustomProviderModels(curated, configs);
  const withListRules = applyProviderModelListRules(withCustomModels, configs);
  const withAccessRules = applyProviderAccessRules(withListRules, configs);
  return applyConfiguredModelDefault(withAccessRules, configs);
};

const parseOpenCodeSessionModelValue = (rawModel: unknown): string | null => {
  if (typeof rawModel === 'string') {
    const trimmed = rawModel.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return parseOpenCodeSessionModelValue(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }

  const record = readObjectRecord(rawModel);
  if (!record) {
    return null;
  }

  const modelId = readOptionalString(record.id)
    ?? readOptionalString(record.model)
    ?? readOptionalString(record.name)
    ?? readOptionalString(record.value);
  if (!modelId) {
    return null;
  }

  // OpenCode persists the provider and model id in separate fields (for
  // example {"id":"z-ai/glm-5.3-flash","providerID":"openrouter"}), and its
  // CLI's `--model` flag only accepts the composed `<providerID>/<modelID>`
  // form. Compose it here so a resumed session resolves the same model
  // instead of failing with an unknown-model error.
  const providerId = readOptionalString(record.providerID)
    ?? readOptionalString(record.providerId);
  if (providerId && !modelId.startsWith(`${providerId}/`)) {
    return `${providerId}/${modelId}`;
  }

  return modelId;
};

/** Provider registry model adapter for OpenCode predefined models and session metadata. */
export class OpenCodeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return loadOpenCodeModelCatalog();
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    // OpenCode's `session` table is keyed by its own session id, so the stable
    // app id has to be translated first; sessions discovered on disk store the
    // provider id in both columns and resolve to themselves.
    const providerSessionId = sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId;

    try {
      const dbPath = getOpenCodeDatabasePath();
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });

      try {
        const row = db.prepare(`
          SELECT
            s.id AS sessionId,
            s.model AS model,
            s.agent AS agent,
            s.directory AS directory,
            s.time_updated AS timeUpdated,
            s.time_created AS timeCreated
          FROM session s
          WHERE s.id = ?
          ORDER BY COALESCE(s.time_updated, s.time_created, 0) DESC
          LIMIT 1
        `).get(providerSessionId) as {
          sessionId?: string;
          model?: unknown;
          agent?: string | null;
          directory?: string | null;
          timeUpdated?: number | null;
          timeCreated?: number | null;
        } | undefined;

        const model = parseOpenCodeSessionModelValue(row?.model);
        if (model) {
          return {
            model,
          };
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to the curated default when OpenCode session lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
