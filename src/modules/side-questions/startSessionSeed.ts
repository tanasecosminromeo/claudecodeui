import { readDraftText, writeDraftText } from '@/shared/chatDrafts';
import type { SideQuestionEntry } from '@/shared/types';

/**
 * The text a new chat starts with when a side question is turned into a
 * session. It names where the question came from and where the transcript is,
 * so the new session can read more context if it needs it. Nothing is sent.
 */
export function buildSideQuestionSeed({
  entry,
  sessionTitle,
  transcriptPath,
}: {
  entry: SideQuestionEntry;
  sessionTitle: string;
  transcriptPath: string | null;
}): string {
  const lines = [`Started from a side question in session "${sessionTitle}" (${entry.sessionId}).`];
  if (transcriptPath) {
    lines.push(`Its transcript is at ${transcriptPath} — read it if you need more context.`);
  }
  lines.push(
    '',
    `Question: ${entry.question}`,
    '',
    'Answer:',
    entry.answer ?? '',
  );
  return lines.join('\n');
}

/**
 * Puts the seed at the top of the project's new-chat draft, keeping any text
 * already typed there below it.
 */
export function writeSideQuestionSeedDraft(projectId: string, seed: string): void {
  const scope = `project:${projectId}`;
  const existing = readDraftText(scope);
  writeDraftText(scope, existing.trim() ? `${seed}\n\n${existing}` : seed);
}
