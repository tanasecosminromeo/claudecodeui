/**
 * Replaces secret values in text with a mask, keeping the surrounding context
 * (the variable name, the PEM header lines, the URL host) so a reader can still
 * tell that something was there.
 *
 * This is a best-effort net for text that is shown to the browser: chat
 * messages, history, search snippets and files that are not protected by name.
 * It works on the shapes of known tokens and on `name = value` pairs, so it
 * can miss a secret with no recognisable name or shape. It must stay idempotent:
 * masking already-masked text changes nothing.
 */

const MASK = '••••';

// PEM private key blocks: keep the BEGIN/END lines, drop the base64 body.
const PEM_PRIVATE_KEY = /(-----BEGIN [^-\r\n]*PRIVATE KEY-----)[\s\S]*?(-----END [^-\r\n]*PRIVATE KEY-----)/g;

// Known token shapes. The lookbehinds stop a match inside a longer word such as
// `risk-assessment-…` or `task-…`.
const TOKEN_SHAPES: ReadonlyArray<RegExp> = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, // Anthropic and OpenAI keys (sk-ant-…, sk-…)
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub classic tokens
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g, // GitLab personal access tokens
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g, // AWS access key ids
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g, // npm tokens
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWTs
];

// `Authorization: Bearer <token>` values that have no name of their own.
const BEARER_TOKEN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;

// `scheme://user:password@host` keeps the user and host, hides the password.
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

// A name is secret when one of its words says so: `API_KEY`, `apiKey`,
// `x-auth-token`, `DB_PASSWORD`. Whole words only, so `keyboard` and
// `tokenizer` are not secret.
const SECRET_WORDS = new Set([
  'key', 'keys', 'token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'pwd',
  'credential', 'credentials', 'auth', 'private',
]);
// `password_reset_url`, `KEY_FILE_EXTENSION`'s siblings and similar names hold
// a location or a label, not the secret itself.
const NON_SECRET_LAST_WORDS = new Set([
  'url', 'uri', 'path', 'file', 'dir', 'name', 'id', 'length', 'len', 'count', 'type',
  'field', 'label', 'endpoint', 'header',
]);
// Bare values that are types or literals in code, not secrets: `token: string`.
const NON_SECRET_BARE_VALUES = new Set([
  'true', 'false', 'null', 'none', 'nil', 'undefined', 'yes', 'no', 'on', 'off',
  'string', 'number', 'boolean', 'any', 'unknown', 'never', 'void', 'object',
]);
// Code that reads a secret from the environment: `token = process.env.TOKEN`.
const READS_FROM_CODE = /^(process|import|os|System|env|ENV|config|settings|options|props|args)[.[(]/;

/** Splits a name into lowercase words: `apiKey`, `API_KEY` and `api-key` all give api, key. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function isSecretName(name: string): boolean {
  const words = nameWords(name);
  if (words.length === 0 || NON_SECRET_LAST_WORDS.has(words[words.length - 1])) {
    return false;
  }
  return words.some((word) => SECRET_WORDS.has(word));
}

/** A value that is already a placeholder or mask: `${TOKEN}`, `<key>`, `***`, `••••`. */
function isPlaceholder(value: string): boolean {
  return /^[•*.x…\s]+$/i.test(value) || /^(\$|%|<|\{|~|\/|\.\.?\/)/.test(value);
}

function isMaskableQuoted(value: string): boolean {
  return value.trim() !== '' && !isPlaceholder(value);
}

function isMaskableBare(value: string): boolean {
  return value !== ''
    && !isPlaceholder(value)
    && !NON_SECRET_BARE_VALUES.has(value.toLowerCase())
    && !/^\d+$/.test(value) // `max_tokens=4096` is a setting, not a key
    && !READS_FROM_CODE.test(value);
}

/**
 * Matches `name = value`, `name: value`, `"name": "value"`, `export NAME=value`.
 * Group 1 is the name, 2 the separator (with any closing quote of a JSON key),
 * 3 the quote around a quoted value, 4 the quoted content, 5 a bare value.
 * `==`, `=>` and `===` are not assignments.
 */
// A bare value never contains `=` (except trailing base64 padding), so
// `note: API_KEY=abc` leaves the inner `API_KEY=` for its own match.
const ASSIGNMENT = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(["']?[ \t]*[=:](?![=>])[ \t]*)(?:(["'`])([^"'`\r\n]*)\3|([^\s"'`;,()[\]{}<>=]+=*)(?![\w(.<=]))/g;

function maskAssignment(
  match: string,
  name: string,
  separator: string,
  quote: string | undefined,
  quoted: string | undefined,
  bare: string | undefined,
): string {
  if (!isSecretName(name)) {
    // Not a secret name, but a quoted value may hold one: `note: "API_KEY=abc"`.
    return quote !== undefined && quoted !== undefined
      ? `${name}${separator}${quote}${maskSecrets(quoted)}${quote}`
      : match;
  }
  if (quote !== undefined) {
    return isMaskableQuoted(quoted ?? '') ? `${name}${separator}${quote}${MASK}${quote}` : match;
  }
  return bare !== undefined && isMaskableBare(bare) ? `${name}${separator}${MASK}` : match;
}

/** Returns `text` with secret values replaced by `••••`. Text without secrets is returned unchanged. */
export function maskSecrets(text: string): string {
  if (!text) {
    return text;
  }
  let masked = text.replace(PEM_PRIVATE_KEY, `$1 ${MASK} $2`);
  for (const shape of TOKEN_SHAPES) {
    masked = masked.replace(shape, MASK);
  }
  masked = masked.replace(BEARER_TOKEN, `$1${MASK}`);
  masked = masked.replace(URL_PASSWORD, `$1${MASK}@`);
  masked = masked.replace(ASSIGNMENT, maskAssignment);
  return masked;
}
