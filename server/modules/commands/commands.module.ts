import * as fs from 'node:fs/promises';
import os from 'node:os';

import { providerModelsService, providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import { createCommandsRouter } from './commands.routes.js';
import { createSideQuestionService } from './side-question.service.js';

const sideQuestionService = createSideQuestionService({
  findSession(sessionId) {
    try {
      const details = sessionsService.getSessionDetailsById(sessionId);
      return { provider: details.provider, projectPath: details.project?.fullPath ?? null };
    } catch {
      // No session row: the client's provider and project path stand in.
      return null;
    }
  },
  askProvider: (provider, sessionId, question, options) =>
    providerRuntimeService.askSideQuestion(provider, sessionId, question, options),
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
