import * as fs from 'node:fs/promises';
import os from 'node:os';

import { sessionsDb, sideQuestionsDb } from '@/modules/database/index.js';
import { providerModelsService, providerRuntimeService } from '@/modules/providers/index.js';
import { broadcastSideQuestionUpdated } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import { createCommandsRouter } from './commands.routes.js';
import { createSideQuestionService } from './side-question.service.js';

const sideQuestionService = createSideQuestionService({
  findSession(sessionId) {
    const row = sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!row) {
      // No session row: the client's provider and project path stand in.
      return null;
    }
    return {
      sessionId: row.session_id,
      provider: row.provider as LLMProvider,
      projectPath: row.project_path?.trim() ? row.project_path : null,
      transcriptPath: row.jsonl_path ?? null,
    };
  },
  supportsSideQuestions: (provider) => providerRuntimeService.supportsSideQuestions(provider),
  askProvider: (provider, sessionId, question, options) =>
    providerRuntimeService.askSideQuestion(provider, sessionId, question, options),
  store: sideQuestionsDb,
  broadcast: broadcastSideQuestionUpdated,
});

/** Commands router assembled for the authenticated server mount. */
export const commandsRoutes = createCommandsRouter({
  fileSystem: fs,
  homeDirectory: os.homedir,
  appRoot: findApplicationRoot(getModuleDirectory(import.meta.url)),
  models: providerModelsService,
  sideQuestions: sideQuestionService,
  runtime: {
    uptime: process.uptime,
    memoryUsage: process.memoryUsage,
    version: process.version,
    platform: process.platform,
    pid: process.pid,
  },
});
