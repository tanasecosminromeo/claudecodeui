export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
// providerRuntimeService: used by the server entrypoint to run provider turns, and
// by Commands to ask `/btw` side questions of a session's runtime.
export { providerRuntimeService } from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read, and
// by Commands to find a `/btw` session's provider and project path.
export { sessionsService } from './services/sessions.service.js';

// findOtherLiveClaudeProcesses: used by the server entrypoint to tell the shell
// tab which Claude processes already have a session open before it resumes one.
export { findOtherLiveClaudeProcesses } from './list/claude/claude-live-processes.js';
// markDetachedClaudeShutdown: used by the server entrypoint's shutdown so nothing
// signals a detached Claude process while the server winds down.
export { markDetachedClaudeShutdown } from './list/claude/claude-detached-process.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
