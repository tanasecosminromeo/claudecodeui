import { maskSecrets } from '@/shared/secret-masking.js';
import type { sideQuestionsDb, SideQuestionRow } from '@/modules/database/index.js';
import type {
  LLMProvider,
  SideQuestionEntry,
  SideQuestionOptions,
  SideQuestionOutcome,
} from '@/shared/types.js';

type SideQuestionStore = Pick<typeof sideQuestionsDb, 'create' | 'markAnswered' | 'markFailed' | 'listBySession'>;

type IndexedSession = {
  /** The app-facing id the row is stored under. */
  sessionId: string;
  provider: LLMProvider;
  projectPath: string | null;
  transcriptPath: string | null;
};

type SideQuestionServiceDependencies = {
  /**
   * The indexed session, or null when the id has no session row (a direct
   * provider-native id the watcher has not indexed).
   */
  findSession(sessionId: string): IndexedSession | null;
  /** False for providers whose runtime cannot answer side questions. */
  supportsSideQuestions(provider: LLMProvider): boolean;
  askProvider(
    provider: LLMProvider,
    sessionId: string,
    question: string,
    options: SideQuestionOptions,
  ): Promise<SideQuestionOutcome>;
  store: SideQuestionStore;
  /** Sends an entry's new state to every connected client. */
  broadcast(sessionId: string, entry: SideQuestionEntry): void;
};

type SideQuestionRequest = {
  sessionId: string | null;
  question: string;
  /** What the client believes the session runs on; the session row wins. */
  provider: LLMProvider;
  projectPath: string | null;
  model: string | null;
};

/**
 * `/btw` result for the command route: either the question was not asked (the
 * status says why), or it was and `entry` is what the panel shows.
 */
export type SideQuestionAsk =
  | { status: 'empty_question' | 'no_context' | 'unsupported' }
  | { entry: SideQuestionEntry };

/** Fallback wording for each `/btw` outcome that is not an answer; the client shows its own translated text. */
export const SIDE_QUESTION_MESSAGES = {
  empty_question: 'Usage: /btw <question>',
  no_context: 'This session has no conversation yet. Send a message first, then ask /btw.',
  unsupported: '/btw is only available in Claude sessions.',
};

const DEFAULT_FAILURE_MESSAGE = 'The side question failed.';

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : DEFAULT_FAILURE_MESSAGE;

// Entries reach the browser outside the chat stream (the panel list and its
// broadcasts), so they get the same key masking as chat messages. The stored
// row keeps the real text; only what is sent is masked.
const masked = (text: string | null): string | null => (text === null ? null : maskSecrets(text));

const toEntry = (row: SideQuestionRow): SideQuestionEntry => ({
  id: row.id,
  sessionId: row.session_id,
  question: maskSecrets(row.question),
  answer: masked(row.answer),
  status: row.status,
  source: row.source,
  error: masked(row.error),
  createdAt: row.created_at,
  answeredAt: row.answered_at,
  saved: true,
});

/**
 * Creates the `/btw` side-question service. Used by the Commands router, which
 * only parses the command and formats whatever this returns.
 */
export function createSideQuestionService(dependencies: SideQuestionServiceDependencies) {
  const { store } = dependencies;

  /**
   * Asks the provider and records the outcome. Runs in the background after
   * `ask` has returned the pending entry; never rejects.
   */
  async function settle(sessionId: string, id: number, provider: LLMProvider, question: string, options: SideQuestionOptions) {
    try {
      let row: SideQuestionRow | null;
      try {
        const outcome = await dependencies.askProvider(provider, sessionId, question, options);
        row = outcome.status === 'answered'
          ? store.markAnswered(id, outcome.answer, outcome.source)
          : store.markFailed(id, SIDE_QUESTION_MESSAGES[outcome.status]);
      } catch (error) {
        row = store.markFailed(id, errorMessage(error));
      }
      if (row) {
        dependencies.broadcast(sessionId, toEntry(row));
      }
    } catch (error) {
      console.error(`[btw] Could not record the side question ${id}:`, error);
    }
  }

  return {
    /**
     * Validates the question. For a session with a row, stores it as pending,
     * returns that entry at once and answers in the background. Without a row,
     * waits for the answer and returns it unsaved.
     */
    async ask(request: SideQuestionRequest): Promise<SideQuestionAsk> {
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
      const options = {
        cwd: session?.projectPath ?? request.projectPath,
        model: request.model,
      };

      if (!session) {
        return askUnsaved(request.sessionId, provider, question, options);
      }

      if (!dependencies.supportsSideQuestions(provider)) {
        return { status: 'unsupported' };
      }

      const row = store.create(session.sessionId, question);
      dependencies.broadcast(session.sessionId, toEntry(row));
      void settle(session.sessionId, row.id, provider, question, options);
      return { entry: toEntry(row) };
    },

    /** The session's stored entries, oldest first, and its transcript path. */
    list(sessionId: string): { entries: SideQuestionEntry[]; transcriptPath: string | null } {
      const session = dependencies.findSession(sessionId);
      const storedId = session?.sessionId ?? sessionId;
      return {
        entries: store.listBySession(storedId).map(toEntry),
        transcriptPath: session?.transcriptPath ?? null,
      };
    },
  };

  /** A session with no row: nothing is stored, so the answer is awaited and returned. */
  async function askUnsaved(
    sessionId: string,
    provider: LLMProvider,
    question: string,
    options: SideQuestionOptions,
  ): Promise<SideQuestionAsk> {
    const createdAt = new Date().toISOString();
    const unsaved = (
      status: SideQuestionEntry['status'],
      answer: string | null,
      source: SideQuestionEntry['source'],
      error: string | null,
    ): SideQuestionAsk => ({
      entry: {
        id: -Date.now(),
        sessionId,
        question: maskSecrets(question),
        answer: masked(answer),
        status,
        source,
        error: masked(error),
        createdAt,
        answeredAt: status === 'answered' ? new Date().toISOString() : null,
        saved: false,
      },
    });

    let outcome: SideQuestionOutcome;
    try {
      outcome = await dependencies.askProvider(provider, sessionId, question, options);
    } catch (error) {
      return unsaved('failed', null, null, errorMessage(error));
    }

    if (outcome.status === 'answered') {
      return unsaved('answered', outcome.answer, outcome.source, null);
    }
    return { status: outcome.status };
  }
}
