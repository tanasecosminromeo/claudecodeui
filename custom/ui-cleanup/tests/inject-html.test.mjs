// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINE_SEP, injectBlock, jsonForScript, parseEnvSwitcher, renderBlock, run } from '../inject-html.mjs';

const CUSTOM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = '<!doctype html><html><head><title>CloudCLI</title></head><body><div id="root"></div></body></html>';

describe('parseEnvSwitcher', () => {
  it('parses name=origin pairs and normalises to origins', () => {
    expect(parseEnvSwitcher(' Dev=https://dev.example.com/some/path , M4=https://m4.example.com:8443 ')).toEqual({
      envs: [{ name: 'Dev', origin: 'https://dev.example.com' }, { name: 'M4', origin: 'https://m4.example.com:8443' }],
      errors: [],
    });
    expect(parseEnvSwitcher('').envs).toEqual([]);
  });

  it('rejects non-https (except loopback), bad names and duplicates', () => {
    expect(parseEnvSwitcher('Dev=http://dev.example.com').errors).toHaveLength(1);
    expect(parseEnvSwitcher('Local=http://127.0.0.1:8022').errors).toEqual([]);
    expect(parseEnvSwitcher('<b>=https://a.example.com').errors).toHaveLength(1);
    expect(parseEnvSwitcher('A=https://a.example.com,B=https://a.example.com').errors).toHaveLength(1);
    expect(parseEnvSwitcher('A=not a url').errors).toHaveLength(1);
    const ten = Array.from({ length: 10 }, (_, i) => `E${i}=https://e${i}.example.com`).join(',');
    expect(parseEnvSwitcher(ten).errors).toContain('at most 9 environments');
  });
});

describe('html', () => {
  it('escapes JSON for an inline script', () => {
    const out = jsonForScript({ name: '</script><script>alert(1)</script>' + LINE_SEP });
    expect(out).not.toContain('</script>');
    expect(JSON.parse(out).name).toBe('</script><script>alert(1)</script>' + LINE_SEP);
  });

  it('replaces the marked block instead of stacking it', () => {
    const once = injectBlock(HTML, '<!-- ui-cleanup:start -->A<!-- ui-cleanup:end -->');
    const twice = injectBlock(once, '<!-- ui-cleanup:start -->B<!-- ui-cleanup:end -->');
    expect(twice.match(/ui-cleanup:start/g)).toHaveLength(1);
    expect(twice).toContain('B<!-- ui-cleanup:end -->\n</head>');
    expect(() => injectBlock('<html></html>', 'x')).toThrow();
  });

  it('adds the switcher only when environments are configured', () => {
    const assets = { cleanupCss: '/c.css', cleanupJs: '/c.js', fonts: null, switcherCss: '/s.css', switcherJs: '/s.js' };
    expect(renderBlock(assets, [])).not.toContain('envsw');
    const block = renderBlock(assets, [{ name: 'Dev', origin: 'https://dev.example.com' }]);
    expect(block).toContain('<script id="envsw-config" type="application/json">');
    expect(block).toContain('<script async src="/s.js"></script>');
  });
});

describe('run', () => {
  let app;
  beforeEach(() => {
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-html-'));
    fs.mkdirSync(path.join(app, 'dist'));
    fs.writeFileSync(path.join(app, 'dist', 'index.html'), HTML);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(app, { recursive: true, force: true });
  });

  it('injects ui-cleanup and the switcher idempotently', () => {
    vi.stubEnv('ENV_SWITCHER', 'Dev=https://dev.example.com,M4=https://m4.example.com');
    run(app, CUSTOM);
    run(app, CUSTOM);
    const html = fs.readFileSync(path.join(app, 'dist', 'index.html'), 'utf8');
    expect(html.match(/ui-cleanup:start/g)).toHaveLength(1);
    expect(html).toMatch(/<script defer src="\/ui-cleanup\/cleanup\.[0-9a-f]{10}\.js"><\/script>/);
    expect(html).toMatch(/<script async src="\/ui-cleanup\/switcher\.[0-9a-f]{10}\.js"><\/script>/);
    expect(html).toContain('{"envs":[{"name":"Dev","origin":"https://dev.example.com"},{"name":"M4","origin":"https://m4.example.com"}]}');
    const files = fs.readdirSync(path.join(app, 'dist', 'ui-cleanup'));
    expect(files.filter((f) => f.startsWith('switcher.'))).toHaveLength(2);
    for (const src of html.match(/\/ui-cleanup\/[^"]+\.(?:js|css)/g)) {
      expect(fs.existsSync(path.join(app, 'dist', src))).toBe(true);
    }
  });

  it('leaves the switcher out when ENV_SWITCHER is unset or invalid', () => {
    vi.stubEnv('ENV_SWITCHER', '');
    run(app, CUSTOM);
    expect(fs.readFileSync(path.join(app, 'dist', 'index.html'), 'utf8')).not.toContain('envsw');
    vi.stubEnv('ENV_SWITCHER', 'Dev=http://dev.example.com');
    run(app, CUSTOM);
    expect(fs.readFileSync(path.join(app, 'dist', 'index.html'), 'utf8')).not.toContain('envsw');
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('ENV_SWITCHER invalid'));
  });

  it('skips quietly when the app is not built', () => {
    fs.rmSync(path.join(app, 'dist'), { recursive: true });
    expect(() => run(app, CUSTOM)).not.toThrow();
  });
});
