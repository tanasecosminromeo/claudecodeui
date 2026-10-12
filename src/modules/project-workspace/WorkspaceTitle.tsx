import { Archive, MessageCircleQuestion } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { LLMProviderLogo } from '@/shared/ui';
import { toggleSideQuestionsPanel, useSideQuestionEntries, useSideQuestionsPanelOpen } from '@/modules/side-questions';
import type { AppTab, Project, ProjectSession } from '@/shared/types';
import { useBackgroundSessionIdSet, useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import { usePaletteOps } from '@/modules/command-palette';
import { usePlugins } from '@/modules/plugins';
import { getSessionTitle } from '@/shared/utils';
import { useSessionTitleRename } from '@/modules/project-workspace/hooks/useSessionTitleRename';

type WorkspaceTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  /** Persists a new title for a session; resolves false when the backend refuses it. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

function getTabTitle(activeTab: AppTab, shouldShowTasksTab: boolean, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'git') {
    return t('tabs.git');
  }

  if (activeTab === 'tasks' && shouldShowTasksTab) {
    return 'TaskMaster';
  }

  if (activeTab === 'browser') {
    return t('tabs.browser');
  }

  return t('misc.projectFallback');
}

/**
 * Rendered by WorkspaceHeader to label the workspace with the active session or
 * tab name. On the chat tab the session title can be double-clicked to rename
 * the session in place, as a second way in beside the sidebar's rename.
 */
export default function WorkspaceTitle({
  activeTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  onRenameSession,
}: WorkspaceTitleProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const { archiveSession } = usePaletteOps();
  // Archiving is withheld while a response is in flight, as on the sidebar
  // row; background-only work does not count.
  const busySessionIds = useBusySessionIdSet();
  const backgroundSessionIds = useBackgroundSessionIdSet();

  const pluginDisplayName = activeTab.startsWith('plugin:')
    ? plugins.find((p) => p.name === activeTab.replace('plugin:', ''))?.displayName
    : undefined;

  const showSessionIcon = activeTab === 'chat' && Boolean(selectedSession);
  const showChatNewSession = activeTab === 'chat' && !selectedSession;
  const canArchiveSession = activeTab === 'chat' && Boolean(selectedSession)
    && !(busySessionIds.has(selectedSession?.id ?? '') && !backgroundSessionIds.has(selectedSession?.id ?? ''));
  const archiveLabel = t('sessions.archiveSession', { ns: 'sidebar', defaultValue: 'Archive session' });
  // `/btw` side questions are answered by Claude only, so the toggle is too.
  const showSideQuestionsToggle = activeTab === 'chat' && selectedSession?.__provider === 'claude';
  const isSideQuestionsOpen = useSideQuestionsPanelOpen();
  const sideQuestionCount = useSideQuestionEntries(selectedSession?.id ?? null).length;

  const sessionTitle = selectedSession ? getSessionTitle(selectedSession) : '';

  const {
    isEditing: isRenaming,
    draft: renameDraft,
    isSaving: isSavingRename,
    inputRef: renameInputRef,
    startEditing: startRenaming,
    updateDraft: updateRenameDraft,
    cancelEditing: cancelRenaming,
    handleInputKeyDown: handleRenameKeyDown,
  } = useSessionTitleRename({
    sessionId: selectedSession?.id ?? null,
    currentTitle: sessionTitle,
    onRenameSession,
  });

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {showSessionIcon && (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <LLMProviderLogo provider={selectedSession?.__provider} className="h-4 w-4" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {activeTab === 'chat' && selectedSession ? (
          <div className="min-w-0">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                value={renameDraft}
                onChange={(event) => updateRenameDraft(event.target.value)}
                onKeyDown={handleRenameKeyDown}
                // Clicking anywhere else cancels, as the sidebar's rename does.
                onBlur={cancelRenaming}
                readOnly={isSavingRename}
                aria-busy={isSavingRename}
                aria-label={t('mainContent.renameSessionLabel')}
                // Blur cancels, so a touch keyboard needs a key that commits.
                enterKeyHint="done"
                className="w-full max-w-md rounded border border-border bg-background px-1.5 py-0.5 text-sm font-semibold leading-tight text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <h2
                title={t('mainContent.renameSessionHint', { title: sessionTitle })}
                onDoubleClick={startRenaming}
                className="cursor-text truncate text-sm font-semibold leading-tight text-foreground"
              >
                {sessionTitle}
              </h2>
            )}
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : showChatNewSession ? (
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="truncate text-xs leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-tight text-foreground">
              {getTabTitle(activeTab, shouldShowTasksTab, t, pluginDisplayName)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        )}
      </div>

      {showSideQuestionsToggle && (
        <button
          type="button"
          onClick={toggleSideQuestionsPanel}
          aria-pressed={isSideQuestionsOpen}
          title={t('misc.sideQuestion.toggle', { ns: 'chat' })}
          aria-label={`${t('misc.sideQuestion.toggle', { ns: 'chat' })}${sideQuestionCount > 0 ? `: ${sideQuestionCount}` : ''}`}
          className={`flex h-7 flex-shrink-0 items-center gap-1 rounded-md px-1.5 text-xs transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
            isSideQuestionsOpen ? 'bg-muted text-foreground' : 'text-muted-foreground'
          }`}
        >
          <MessageCircleQuestion className="h-4 w-4" />
          {sideQuestionCount > 0 && <span className="tabular-nums">{sideQuestionCount}</span>}
        </button>
      )}

      {canArchiveSession && selectedSession && (
        // Phones only (the sidebar row has its own icon on desktop): the sidebar is a
        // closed drawer there, so this is the only one-tap archive.
        <button
          type="button"
          onClick={() => archiveSession(selectedSession)}
          title={archiveLabel}
          aria-label={`${archiveLabel}: ${getSessionTitle(selectedSession)}`}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 md:hidden"
        >
          <Archive className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
