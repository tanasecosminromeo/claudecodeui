/**
 * The session status keys, in the order the picker lists them. The keys match
 * the server's `SESSION_STATUS_KEYS`; labels come from the sidebar i18n file.
 */
export const SESSION_STATUS_KEYS = [
  'bug',
  'investigation',
  'testing',
  'planning',
  'building',
  'refactor',
  'release',
  'question',
  'done',
  'blocked',
] as const;

export type SessionStatusKey = (typeof SESSION_STATUS_KEYS)[number];

/** Emoji shown before a session title. `blocked` means Claude is waiting on the user. */
export const SESSION_STATUS_EMOJI: Record<SessionStatusKey, string> = {
  bug: '🐛',
  investigation: '🔍',
  testing: '🧪',
  planning: '📝',
  building: '🛠️',
  refactor: '♻️',
  release: '🚀',
  question: '❓',
  done: '✅',
  blocked: '⏸️',
};

export const isSessionStatusKey = (value: unknown): value is SessionStatusKey => {
  return typeof value === 'string' && (SESSION_STATUS_KEYS as readonly string[]).includes(value);
};

/** The emoji for a stored status, or null when the session has none (no emoji is shown). */
export const getSessionStatusEmoji = (status: string | null | undefined): string | null => {
  return isSessionStatusKey(status) ? SESSION_STATUS_EMOJI[status] : null;
};
