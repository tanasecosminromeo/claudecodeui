import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Loader2, MessageCircleQuestion, MessageSquarePlus, RotateCw, Send, X } from 'lucide-react';

import { Markdown } from '@/modules/chat';
import { Button } from '@/shared/ui';
import type { AppTab, Project, ProjectSession, SideQuestionEntry } from '@/shared/types';
import { getSessionTitle } from '@/shared/utils';
import { useSideQuestions } from '@/modules/side-questions/useSideQuestions';
import { setSideQuestionsPanelOpen, useSideQuestionsPanelOpen } from '@/modules/side-questions/sideQuestionsStore';
import { buildSideQuestionSeed, writeSideQuestionSeedDraft } from '@/modules/side-questions/startSessionSeed';

type SideQuestionsPanelProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  isMobile: boolean;
  /** Starts a new chat in the project (the workspace's handleNewSession). */
  onStartNewChat: (project: Project) => void;
};

/**
 * The `/btw` side-question panel. Docked as a column beside the chat on the
 * Chat tab, a full-screen sheet on phones. It is an `<aside>`, not a dialog, so
 * Escape still stops Claude's turn while it is open. It stays mounted while
 * closed so the title's count and the list stay current.
 */
function SideQuestionsPanel({
  selectedProject,
  selectedSession,
  activeTab,
  isMobile,
  onStartNewChat,
}: SideQuestionsPanelProps) {
  const { t } = useTranslation('chat');
  const isOpen = useSideQuestionsPanelOpen();
  const sessionId = selectedSession?.id ?? null;
  const { entries, transcriptPath, notice, canAsk, ask, retry } = useSideQuestions(sessionId, selectedProject);

  const [draft, setDraft] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const newestId = entries[entries.length - 1]?.id ?? null;

  const isVisible = isOpen
    && activeTab === 'chat'
    && Boolean(selectedProject)
    && (!selectedSession || selectedSession.__provider === 'claude');

  // Follow the conversation: the newest entry is at the bottom.
  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [newestId, isVisible]);

  if (!isVisible || !selectedProject) {
    return null;
  }

  const sessionTitle = selectedSession ? getSessionTitle(selectedSession) : '';

  const send = () => {
    if (!canAsk || !draft.trim()) {
      return;
    }
    const question = draft;
    setDraft('');
    void ask(question);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const copyAnswer = (entry: SideQuestionEntry) => {
    void navigator.clipboard?.writeText(entry.answer ?? '').then(() => {
      setCopiedId(entry.id);
      window.setTimeout(() => setCopiedId((current) => (current === entry.id ? null : current)), 1500);
    });
  };

  const startSession = (entry: SideQuestionEntry) => {
    writeSideQuestionSeedDraft(selectedProject.projectId, buildSideQuestionSeed({
      entry,
      sessionTitle,
      transcriptPath,
    }));
    onStartNewChat(selectedProject);
  };

  const panelClass = isMobile
    ? 'fixed inset-0 z-[9998] flex flex-col bg-background'
    : 'relative flex h-full w-96 flex-shrink-0 flex-col border-l border-border bg-background';

  return (
    <aside aria-label={t('misc.sideQuestion.title')} className={panelClass}>
      <header className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-3">
        <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <MessageCircleQuestion className="h-4 w-4 text-muted-foreground" />
          {t('misc.sideQuestion.title')}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setSideQuestionsPanelOpen(false)}
          aria-label={t('misc.sideQuestion.close')}
          className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div ref={listRef} className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {entries.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('misc.sideQuestion.empty')}</p>
        )}

        {entries.map((entry) => (
          <article key={entry.id} className="flex flex-col gap-2 border-b border-border/60 pb-4 last:border-b-0">
            <p className="whitespace-pre-wrap break-words text-sm font-medium text-foreground">{entry.question}</p>

            {entry.status === 'pending' && (
              <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                {t('misc.sideQuestion.answering')}
              </div>
            )}

            {entry.status === 'answered' && (
              <>
                <Markdown className="prose prose-sm prose-gray max-w-none font-serif dark:prose-invert">
                  {entry.answer ?? ''}
                </Markdown>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => copyAnswer(entry)} className="rounded-xl">
                    {copiedId === entry.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copiedId === entry.id ? t('misc.sideQuestion.copied') : t('misc.sideQuestion.copy')}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => startSession(entry)} className="rounded-xl">
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                    {t('misc.sideQuestion.startSession')}
                  </Button>
                </div>
              </>
            )}

            {entry.status === 'failed' && (
              <div role="alert" className="flex flex-col items-start gap-2">
                <p className="text-sm text-destructive">{entry.error || t('misc.sideQuestion.failed')}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void retry(entry)} className="rounded-xl">
                  <RotateCw className="h-3.5 w-3.5" />
                  {t('misc.sideQuestion.retry')}
                </Button>
              </div>
            )}

            {!entry.saved && (
              <p className="text-[11px] text-muted-foreground">{t('misc.sideQuestion.notSaved')}</p>
            )}
          </article>
        ))}
      </div>

      {notice && (
        <p role="status" className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
          {notice}
        </p>
      )}

      {!canAsk && (
        <p className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
          {t('misc.sideQuestion.noSessionHint')}
        </p>
      )}

      <div className="flex items-end gap-2 border-t border-border bg-background px-4 py-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleInputKeyDown}
          disabled={!canAsk}
          rows={2}
          placeholder={canAsk ? t('misc.sideQuestion.placeholder') : t('misc.sideQuestion.noSessionHint')}
          aria-label={t('misc.sideQuestion.placeholder')}
          className="max-h-40 min-h-10 flex-1 resize-none rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={send}
          disabled={!canAsk || !draft.trim()}
          aria-label={t('misc.sideQuestion.send')}
          className="h-10 w-10 flex-shrink-0 rounded-xl"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </aside>
  );
}

export default SideQuestionsPanel;
