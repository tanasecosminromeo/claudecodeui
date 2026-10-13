// Masks secrets in process command lines before session-radar sends them to the browser.
// Ported from server/shared/secret-masking.ts (not imported: this plugin is copied on its own).
// Keeps the key or flag visible and replaces only the value with MASK, so a reader still sees
// that a token was passed. Idempotent: masking masked text changes nothing.

const MASK = '•••';
const KW = '(?:token|secret|password|passwd|api[_-]?key|auth|credential|private[_-]?key|session[_-]?key)';
const NAME = `[\\w.-]*${KW}[\\w.-]*`;

// PEM private key blocks: keep the BEGIN/END lines, drop the body.
const PEM_PRIVATE_KEY = /(-----BEGIN [^-\r\n]*PRIVATE KEY-----)[\s\S]*?(-----END [^-\r\n]*PRIVATE KEY-----)/g;

// Known token shapes, whatever the name they are passed under.
const TOKEN_SHAPES = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, // Anthropic and OpenAI keys
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub classic tokens
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g, // GitLab personal access tokens
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g, // AWS access key ids
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g, // npm tokens
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWTs
];

// `Bearer <token>` values.
const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
// `scheme://user:password@host` keeps user and host, hides the password.
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
// `Authorization: [Bearer|Basic|Token] value`, with or without a quote around it.
const AUTH_HEADER = /(\b(?:Proxy-)?Authorization:\s*(?:(?:Bearer|Basic|Token)\s+)?)[^\s'"]+/gi;
// Query parameters with generic names.
const QUERY_SECRET = /([?&](?:key|sig|signature)=)[^&\s#"']+/gi;
// JSON: `"FOO_TOKEN": "value"`.
const JSON_PAIR = new RegExp(`("${NAME}"\\s*:\\s*")([^"]*)(")`, 'gi');
// Flag with a separate value: `--api-key value`.
const FLAG_VALUE = new RegExp(`(--${NAME})(\\s+)(["']?)([^\\s"'-][^\\s"']*)`, 'gi');
// Assignment: `FOO_TOKEN=value`, `--token=value`, `FOO_TOKEN="value"`.
const ASSIGN = new RegExp(`(?<![\\w.-])(${NAME})(=)(?:(["'])([^"'\\n]*)\\3|([^\\s"'&;]+))`, 'gi');
// Bare runs that look like keys: hex of 48+ chars; base64-ish of 40+ with letters and digits.
const HEX_RUN = /(?<![0-9A-Za-z])[0-9a-fA-F]{48,}(?![0-9A-Za-z])/g;
const B64_RUN = /(?<![A-Za-z0-9+/_.-])[A-Za-z0-9+]{40,}={0,2}(?![A-Za-z0-9+/_.-])/g;

/** A value that is already a placeholder or a variable reference: `$TOKEN`, `<key>`, `{x}`. */
const isPlaceholder = (v) => v === '' || /^[$<{]/.test(v) || v.includes(MASK);

/**
 * Returns `text` with secret values replaced by `•••`. Text without secrets comes back unchanged.
 * Git SHAs (40 hex characters) and UUIDs stay readable; paths and ordinary words are not touched.
 */
export function maskSecrets(text) {
  if (!text) return text;
  let s = String(text).replace(PEM_PRIVATE_KEY, `$1 ${MASK} $2`);
  for (const shape of TOKEN_SHAPES) s = s.replace(shape, MASK);
  s = s.replace(BEARER, `$1${MASK}`);
  s = s.replace(URL_PASSWORD, `$1${MASK}@`);
  s = s.replace(AUTH_HEADER, `$1${MASK}`);
  s = s.replace(QUERY_SECRET, `$1${MASK}`);
  s = s.replace(JSON_PAIR, (m, pre, val, post) => (isPlaceholder(val) ? m : `${pre}${MASK}${post}`));
  s = s.replace(FLAG_VALUE, (m, flag, sp, q, val) => (isPlaceholder(val) ? m : `${flag}${sp}${q}${MASK}`));
  s = s.replace(ASSIGN, (m, name, eq, q, quoted, bare) => {
    const val = q !== undefined ? quoted : bare;
    if (isPlaceholder(val)) return m;
    return q !== undefined ? `${name}${eq}${q}${MASK}${q}` : `${name}${eq}${MASK}`;
  });
  s = s.replace(HEX_RUN, MASK);
  s = s.replace(B64_RUN, (m) => (/[A-Za-z]/.test(m) && /\d/.test(m) && !/^[0-9a-fA-F]+$/.test(m) ? MASK : m));
  return s;
}
