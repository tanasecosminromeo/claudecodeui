import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests for the custom/ layer only (run with `make test-custom`); the app's suites keep their own configs.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['custom/**/tests/*.test.{js,mjs}'],
    environment: 'jsdom',
    // The switcher decides host/embedded behaviour from location.origin, so pin it to a configured env.
    environmentOptions: { jsdom: { url: 'https://dev.example.com/' } },
    restoreMocks: true,
    // jsdom can't focus windows or navigate cross-origin; the switcher does both on purpose.
    onConsoleLog: (log) => !/Not implemented: (window\.focus|navigation)/.test(log),
  },
});
