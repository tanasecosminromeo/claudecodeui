import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import sessionStatusChecksRouter from '@/modules/providers/session-status-checks.routes.js';
import { AppError } from '@/shared/utils.js';

async function withStatusChecksServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-status-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  // The real mount also runs authenticateToken; that is covered by the server's own auth tests.
  const app = express()
    .use(express.json())
    .use('/api/session-status-checks', sessionStatusChecksRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('GET returns the settings and the stats in one body', async () => {
  await withStatusChecksServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/session-status-checks/`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      settings: Record<string, unknown>;
      stats: { today: Record<string, unknown>; days: unknown[]; last: unknown };
    };
    assert.deepEqual(body.settings, {
      enabled: true,
      freeBlockedCheck: true,
      dailyLimit: 500,
      firstTurn: 3,
      interval: 5,
    });
    assert.equal(body.stats.days.length, 14);
    assert.equal(body.stats.last, null);
    assert.equal(body.stats.today.limit, 500);
  });
});

test('PUT /settings saves the partial settings and returns the same shape', async () => {
  await withStatusChecksServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/session-status-checks/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailyLimit: 400, enabled: false }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { settings: Record<string, unknown>; stats: { today: { limit: number } } };
    assert.equal(body.settings.dailyLimit, 400);
    assert.equal(body.settings.enabled, false);
    assert.equal(body.settings.interval, 5);
    assert.equal(body.stats.today.limit, 400);

    const again = (await (await fetch(`${baseUrl}/api/session-status-checks/`)).json()) as {
      settings: { dailyLimit: number; enabled: boolean };
    };
    assert.equal(again.settings.dailyLimit, 400);
    assert.equal(again.settings.enabled, false);
  });
});

test('PUT /settings with an out-of-range value is a 400 and saves nothing', async () => {
  await withStatusChecksServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/session-status-checks/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailyLimit: 9000 }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'INVALID_SESSION_STATUS_SETTINGS');
    assert.equal(body.error.message, 'dailyLimit must be from 0 to 5000; got 9000.');

    const current = (await (await fetch(`${baseUrl}/api/session-status-checks/`)).json()) as {
      settings: { dailyLimit: number };
    };
    assert.equal(current.settings.dailyLimit, 500);
  });
});
