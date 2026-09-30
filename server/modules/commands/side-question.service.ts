import type { LLMProvider, SideQuestionOptions, SideQuestionOutcome } from '@/shared/types.js';

type SideQuestionServiceDependencies = {
  /**
   * The indexed session's provider and project path, or null when the id has
   * no session row (a direct provider-native id the watcher has not indexed).
   */
  findSession(sessionId: string): { provider: LLMProvider; projectPath: string | null } | null;
  askProvider(
    provider: LLMProvider,
    sessionId: string,
    question: string,
    options: SideQuestionOptions,
  ): Promise<SideQuestionOutcome>;
};

type SideQuestionRequest = {
  sessionId: string | null;
  question: string;
  /** What the client believes the session runs on; the session row wins. */
  provider: LLMProvider;
  projectPath: string | null;
  model: string | null;
};

/** `/btw` result for the command route: an outcome, or a question that was never asked. */
type SideQuestionResult = SideQuestionOutcome | { status: 'empty_question' };

/**
 * Creates the `/btw` side-question service. Used by the Commands router, which
 * only parses the command and formats whatever this returns.
 */
export function createSideQuestionService(dependencies: SideQuestionServiceDependencies) {
  return {
    async ask(request: SideQuestionRequest): Promise<SideQuestionResult> {
      const question = request.question.trim();
      if (!question) {
        return { status: 'empty_question' };
      }
      // A chat gets its session id with its first send; before that there is
      // no conversation to ask about.
      if (!request.sessionId) {
        return { status: 'no_context' };
      }

      // The session row is authoritative for which provider and folder the
      // conversation lives in; the client's view only covers unindexed ids.
      const session = dependencies.findSession(request.sessionId);
      const provider = session?.provider ?? request.provider;
      return dependencies.askProvider(provider, request.sessionId, question, {
        cwd: session?.projectPath ?? request.projectPath,
        model: request.model,
      });
    },
  };
}
