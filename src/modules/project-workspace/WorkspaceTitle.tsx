import { Archive } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { LLMProviderLogo } from '@/shared/ui';
import type { AppTab, Project, ProjectSession } from '@/shared/types';
import { useBackgroundSessionIdSet, useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import { usePaletteOps } from '@/modules/command-palette';
import { usePlugins } from '@/modules/plugins';
import { getSessionTitle } from '@/shared/utils';

type WorkspaceTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
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

/** Rendered by WorkspaceHeader to label the workspace with the active session or tab name. */
export default function WorkspaceTitle({
  activeTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
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
            <h2 title={getSessionTitle(selectedSession)} className="truncate text-sm font-semibold leading-tight text-foreground">
              {getSessionTitle(selectedSession)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : showChatNewSession ? (
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="truncate text-xs leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight text-foreground">
              {getTabTitle(activeTab, shouldShowTasksTab, t, pluginDisplayName)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        )}
      </div>

      {canArchiveSession && selectedSession && (
        // One click for the open session — on phones, where the sidebar is a
        // closed drawer, this is the only one-tap archive.
        <button
          type="button"
          onClick={() => archiveSession(selectedSession)}
          title={archiveLabel}
          aria-label={`${archiveLabel}: ${getSessionTitle(selectedSession)}`}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <Archive className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
