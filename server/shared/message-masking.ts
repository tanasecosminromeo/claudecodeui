import path from 'node:path';

import { isProtectedPath } from '@/shared/protected-paths.js';
import { maskSecrets } from '@/shared/secret-masking.js';
import type { NormalizedMessage } from '@/shared/types.js';

/** What the UI shows in place of a protected file's contents. */
export const PROTECTED_CONTENT_NOTICE = '(Protected: may contain keys. Contents hidden.)';

// Deeper than any real tool input; stops a pathological value from recursing forever.
const MAX_DEPTH = 8;
const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const;
// Tools that write file content: their content-bearing inputs are hidden too.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EDIT_CONTENT_FIELDS = new Set(['content', 'old_string', 'new_string', 'new_source']);
// Message fields that carry text shown to the user.
const TEXT_FIELDS = ['content', 'text', 'displayText', 'commandArgs', 'commandMessage', 'input'] as const;

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `~`, `~/x`, `$HOME/x` and `${HOME}/x` become absolute; other relative paths are placed under home. */
function toCheckablePath(token: string, home: string): string {
  const expanded = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.test(token)
    ? home + token.replace(/^(?:~|\$HOME|\$\{HOME\})/, '')
    : token;
  // A relative path is judged by its name, and by the home rules as if it sat in home.
  return path.isAbsolute(expanded) ? expanded : path.join(home, expanded);
}

function commandTouchesProtectedPath(command: string, home: string): boolean {
  return command
    .split(/[\s"'`;|&<>()=]+/)
    .some((token) => token !== '' && isProtectedPath(toCheckablePath(token, home), home));
}

/** Whether a tool call reads or writes a protected file, by its path inputs or its shell command. */
function targetsProtectedPath(toolInput: unknown, home: string): boolean {
  if (!isRecord(toolInput)) {
    return false;
  }
  for (const field of PATH_FIELDS) {
    const value = toolInput[field];
    if (typeof value === 'string' && value !== '' && isProtectedPath(toCheckablePath(value, home), home)) {
      return true;
    }
  }
  return typeof toolInput.command === 'string' && commandTouchesProtectedPath(toolInput.command, home);
}

/** Replaces the content-bearing strings of an edit tool's input, at any depth (e.g. `edits[]`). */
function hideEditContent(value: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => hideEditContent(item, depth + 1));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    EDIT_CONTENT_FIELDS.has(key) && typeof item === 'string'
      ? PROTECTED_CONTENT_NOTICE
      : hideEditContent(item, depth + 1),
  ]));
}

/** Masks every string inside a value, at any depth, without changing its shape. */
function maskDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return maskSecrets(value);
  }
  if (depth >= MAX_DEPTH || typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskDeep(item, depth + 1));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskDeep(item, depth + 1)]));
}

/** A tool result's content, hidden: a string stays a string, a parts array keeps one text part. */
function hiddenContent(content: unknown): unknown {
  return Array.isArray(content) ? [{ type: 'text', text: PROTECTED_CONTENT_NOTICE }] : PROTECTED_CONTENT_NOTICE;
}

/**
 * Copies `message`, hiding its output when `hideOutput` is set, and masks every
 * other shown string. Never mutates the input.
 */
function maskMessage(message: NormalizedMessage, home: string, hideOutput: boolean): NormalizedMessage {
  const copy: AnyRecord = { ...message };
  const editsProtectedFile = hideOutput
    && message.toolName !== undefined
    && EDIT_TOOLS.has(message.toolName)
    && targetsProtectedPath(message.toolInput, home);
  if (hideOutput) {
    if (message.toolResult && message.toolResult.content !== undefined) {
      copy.toolResult = { ...message.toolResult, content: hiddenContent(message.toolResult.content) };
    }
    if (message.kind === 'tool_result' && message.content !== undefined) {
      copy.content = PROTECTED_CONTENT_NOTICE;
    }
  }
  if (editsProtectedFile) {
    copy.toolInput = hideEditContent(message.toolInput, 0);
  }
  for (const field of TEXT_FIELDS) {
    if (copy[field] !== undefined) {
      copy[field] = maskDeep(copy[field]);
    }
  }
  if (copy.toolInput !== undefined) {
    copy.toolInput = maskDeep(copy.toolInput);
  }
  if (copy.toolResult !== undefined) {
    copy.toolResult = maskDeep(copy.toolResult);
  }
  return copy as NormalizedMessage;
}

/**
 * A copy of `message` safe to show: when it is a tool call on a protected file,
 * the file's content is hidden (tool name, path and command stay visible), and
 * every other shown string has its secrets masked. The input is never mutated.
 */
export function maskNormalizedMessage(message: NormalizedMessage, home: string): NormalizedMessage {
  return maskMessage(message, home, targetsProtectedPath(message.toolInput, home));
}

/**
 * Masks a whole conversation. A `tool_result` row carries no tool name or path,
 * only its `toolId`, so the protected calls are found first and their result
 * rows are hidden with them. Message count and order are unchanged.
 */
export function maskNormalizedMessages(messages: NormalizedMessage[], home: string): NormalizedMessage[] {
  const protectedToolIds = new Set<string>();
  for (const message of messages) {
    if (message.toolId && targetsProtectedPath(message.toolInput, home)) {
      protectedToolIds.add(message.toolId);
    }
  }
  return messages.map((message) => {
    const resultOfProtectedCall = message.kind === 'tool_result'
      && message.toolId !== undefined
      && protectedToolIds.has(message.toolId);
    return maskMessage(message, home, resultOfProtectedCall || targetsProtectedPath(message.toolInput, home));
  });
}
