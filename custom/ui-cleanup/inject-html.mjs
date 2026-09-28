// Injects the custom layer into CloudCLI UI's built dist/index.html: ui-cleanup (css/js/fonts) and,
// when ENV_SWITCHER is set, the env-switcher (css/js + inline config). Pure Node so it behaves the
// same on macOS (BSD tools) and Linux. Idempotent: the marked block is replaced on every run.
//   node inject-html.mjs <app-root>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const START = '<!-- ui-cleanup:start -->';
const END = '<!-- ui-cleanup:end -->';
const BLOCK_RE = /<!-- ui-cleanup:start -->[\s\S]*?<!-- ui-cleanup:end -->\n?/g;
const MAX_ENVS = 9; // Ctrl+Option+1..9
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// JSON allows these raw; older JS parsers treat them as line breaks inside a string.
export const LINE_SEP = String.fromCharCode(0x2028);
export const PARA_SEP = String.fromCharCode(0x2029);

// "Dev=https://a.example.com,M4=https://b.example.com" -> { envs: [{ name, origin }], errors }
export function parseEnvSwitcher(value) {
  const envs = [];
  const errors = [];
  const items = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    const eq = item.indexOf('=');
    const name = eq > 0 ? item.slice(0, eq).trim() : '';
    const raw = eq > 0 ? item.slice(eq + 1).trim() : '';
    if (!/^[\p{L}\p{N} _.-]{1,24}$/u.test(name)) { errors.push(`bad name in "${item}"`); continue; }
    let url;
    try { url = new URL(raw); } catch { errors.push(`bad URL in "${item}"`); continue; }
    // http is only for trying it out on this machine; anything reachable from outside must be https
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
      errors.push(`"${item}" must be https`);
      continue;
    }
    if (envs.some((e) => e.origin === url.origin || e.name === name)) { errors.push(`duplicate "${item}"`); continue; }
    envs.push({ name, origin: url.origin });
  }
  if (envs.length > MAX_ENVS) errors.push(`at most ${MAX_ENVS} environments`);
  return { envs, errors };
}

// JSON that is safe inside <script>: no "</script>", no HTML comment openers, no JS line separators.
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replaceAll(LINE_SEP, '\\u2028')
    .replaceAll(PARA_SEP, '\\u2029');
}

export function injectBlock(html, block) {
  const stripped = html.replace(BLOCK_RE, '');
  if (!stripped.includes('</head>')) throw new Error('no </head> in index.html');
  return stripped.replace('</head>', `${block}\n</head>`);
}

// assets: { cleanupCss, cleanupJs, fonts, switcherCss, switcherJs } as served hrefs (or null)
export function renderBlock(assets, envs) {
  const parts = [START];
  if (assets.fonts) {
    for (const f of ['MesloLGS-NF-Regular.woff2', 'MesloLGS-NF-Bold.woff2']) {
      parts.push(`<link rel="preload" href="${assets.fonts}/${f}" as="font" type="font/woff2" crossorigin />`);
    }
  }
  parts.push(`<link rel="stylesheet" href="${assets.cleanupCss}" />`, `<script defer src="${assets.cleanupJs}"></script>`);
  if (envs && envs.length > 0 && assets.switcherCss && assets.switcherJs) {
    parts.push(
      `<link rel="stylesheet" href="${assets.switcherCss}" />`,
      `<script id="envsw-config" type="application/json">${jsonForScript({ envs })}</script>`,
      // async, not defer: the embedded handshake must not wait for the app bundle
      `<script async src="${assets.switcherJs}"></script>`,
    );
  }
  parts.push(END);
  return parts.join('');
}

// Content-hashed copy: the server serves JS/CSS with a 1-year immutable cache.
function copyHashed(file, outDir) {
  const buf = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const ext = path.extname(file);
  const name = `${path.basename(file, ext)}.${hash}${ext}`;
  fs.writeFileSync(path.join(outDir, name), buf);
  return { name, hash };
}

// ENV_SWITCHER from the process env, else from <app>/.env (for manual runs outside the service).
function readEnvSwitcher(appDir) {
  if (process.env.ENV_SWITCHER !== undefined) return process.env.ENV_SWITCHER;
  try {
    const line = fs.readFileSync(path.join(appDir, '.env'), 'utf8').split(/\r?\n/)
      .find((l) => /^\s*(export\s+)?ENV_SWITCHER\s*=/.test(l));
    return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2') : '';
  } catch {
    return '';
  }
}

export function run(appDir, customDir) {
  const index = path.join(appDir, 'dist', 'index.html');
  if (!fs.existsSync(index)) {
    console.error(`ui-cleanup: ${index} not found (not built yet?), skipping`);
    return;
  }
  const outDir = path.join(appDir, 'dist', 'ui-cleanup');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const cleanupDir = path.join(customDir, 'ui-cleanup');
  const href = (name) => `/ui-cleanup/${name}`;
  const css = copyHashed(path.join(cleanupDir, 'cleanup.css'), outDir);
  const js = copyHashed(path.join(cleanupDir, 'cleanup.js'), outDir);
  const assets = { cleanupCss: href(css.name), cleanupJs: href(js.name), fonts: null, switcherCss: null, switcherJs: null };
  const fontsDir = path.join(cleanupDir, 'fonts');
  if (fs.existsSync(fontsDir)) {
    fs.cpSync(fontsDir, path.join(outDir, 'fonts'), { recursive: true });
    assets.fonts = href('fonts');
  }

  const { envs, errors } = parseEnvSwitcher(readEnvSwitcher(appDir));
  const switcherDir = path.join(customDir, 'env-switcher');
  let switcherNote = 'env-switcher: disabled (ENV_SWITCHER unset)';
  if (errors.length > 0) {
    switcherNote = `env-switcher: disabled, ENV_SWITCHER invalid: ${errors.join('; ')}`;
  } else if (envs.length > 0 && fs.existsSync(path.join(switcherDir, 'switcher.js'))) {
    assets.switcherCss = href(copyHashed(path.join(switcherDir, 'switcher.css'), outDir).name);
    assets.switcherJs = href(copyHashed(path.join(switcherDir, 'switcher.js'), outDir).name);
    switcherNote = `env-switcher: ${envs.map((e) => e.name).join(', ')}`;
  }
  const block = renderBlock(assets, errors.length > 0 ? [] : envs);

  const html = injectBlock(fs.readFileSync(index, 'utf8'), block);
  const tmp = `${index}.tmp`;
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, index);
  console.log(`ui-cleanup: injected css=${css.hash} js=${js.hash} into ${index}; ${switcherNote}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    run(path.resolve(process.argv[2] || path.join(here, '..', '..')), path.resolve(here, '..'));
  } catch (err) {
    console.error(`ui-cleanup: inject failed: ${err.message}`);
    process.exitCode = 1;
  }
}
