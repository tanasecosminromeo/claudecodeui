import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { api } from '@/shared/api';
import { DEFAULT_PROJECT_SORT_ORDER, PROJECT_SORT_ORDERS, subscribeToUserPreferences } from '@/shared/userSettings';
import { usePaletteOps } from '@/modules/command-palette';
import type { ArchivedProjectListItem, ArchivedSessionListItem, ConversationProjectResult, ConversationSearchResults, LLMProvider, Project, ProjectGroup, ProjectSession, SessionMetaPatch, StarColor, StarFilter, ProjectSortOrder, RecentConversationListItem, SearchProgress, ActiveSidebarRename, PendingSidebarDeletion, SessionTitleSearchResult, SessionWithProvider, SidebarSearchMode, SidebarSessionSelection } from '@/shared/types';
import { useQuickArchive } from '@/modules/sidebar/hooks/useQuickArchive';
import {
  filterProjects,
  filterProjectsByStar,
  getAllSessions,
  starFilterOptions,
  sortProjects,
} from '@/modules/sidebar/utils/sidebarProjectFormatting';
import {
  clearLegacyStarredProjectIds,
  readCollapsedProjectGroupIds,
  readLegacyStarredProjectIds,
  readProjectSortOrder,
  readProjectStarFilter,
  writeCollapsedProjectGroupIds,
  writeProjectSortOrder,
  writeProjectStarFilter,
} from '@/modules/sidebar/utils/sidebarStoredPreferences';
import {
  getStarColor,
  nextStarFilter,
  normalizeStarFilter,
  starAfterClick,
} from '@/modules/sidebar/utils/starColors';

type ProjectGroupsApiPayload = {
  success?: boolean;
  data?: {
    groups?: ProjectGroup[];
    group?: ProjectGroup;
  };
};

// Server errors come back either as a string or as `{ message }`.
const readApiErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: string | { message?: string } };
    const errorPayload = payload.error;
    if (typeof errorPayload === 'string') {
      return errorPayload;
    }
    return errorPayload?.message || fallback;
  } catch {
    return fallback;
  }
};


type ArchivedSessionsApiPayload = {
  success?: boolean;
  data?: {
    sessions?: ArchivedSessionListItem[];
  };
};

type ArchivedProjectsApiPayload = {
  success?: boolean;
  data?: {
    projects?: ArchivedProjectListItem[];
  };
};

type RecentConversationsApiPayload = {
  success?: boolean;
  data?: {
    conversations?: RecentConversationListItem[];
    total?: number;
    hasMore?: boolean;
  };
};

const EMPTY_PROJECT_GROUPS: ProjectGroup[] = [];

type UseSidebarControllerArgs = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeSessions: ReadonlySet<string>;
  /** The busy sessions only running background work; unlike the rest of `activeSessions` they can be deleted. */
  backgroundSessionIds: ReadonlySet<string>;
  isLoading: boolean;
  isMobile: boolean;
  t: TFunction;
  onRefresh: () => Promise<void> | void;
  /** Persists a pin change and resolves `true` when it was saved. */
  onSetSessionPinned?: (sessionId: string, pinned: boolean) => Promise<boolean>;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onSessionDelete?: (sessionId: string) => void;
  /** Writes an automatic rename or status change onto the open session and the loaded project rows. */
  onSessionUpdated?: (sessionId: string, patch: SessionMetaPatch) => void;
  onLoadMoreSessions?: (projectId: string) => Promise<void> | void;
  // `projectId` is the DB-assigned identifier; callbacks use that post-migration.
  onProjectDelete?: (projectId: string) => void;
  setCurrentProject: (project: Project) => void;
  setSidebarVisible: (visible: boolean) => void;
  sidebarVisible: boolean;
};

export function useSidebarController({
  projects,
  selectedProject,
  selectedSession,
  activeSessions,
  backgroundSessionIds,
  isLoading,
  isMobile,
  t,
  onRefresh,
  onSetSessionPinned,
  onProjectSelect,
  onSessionSelect,
  onSessionDelete,
  onSessionUpdated,
  onLoadMoreSessions,
  onProjectDelete,
  setCurrentProject,
  setSidebarVisible,
  sidebarVisible,
}: UseSidebarControllerArgs) {
  const paletteOps = usePaletteOps();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  // Running groups start expanded and remember manual collapses independently of Projects.
  const [collapsedRunningProjects, setCollapsedRunningProjects] = useState<Set<string>>(new Set());
  // The one rename the sidebar has open, as a single value so a project and a
  // session cannot both be mid-rename. See ActiveSidebarRename.
  const [activeRename, setActiveRename] = useState<ActiveSidebarRename | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [initialSessionsLoaded, setInitialSessionsLoaded] = useState<Set<string>>(new Set());
  const [currentTime, setCurrentTime] = useState(new Date());
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>(DEFAULT_PROJECT_SORT_ORDER);
  const [starFilter, setStarFilter] = useState<StarFilter>(() => readProjectStarFilter());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [deletingProjects, setDeletingProjects] = useState<Set<string>>(new Set());
  // The one delete confirmation the sidebar has open. One value because the
  // project and session dialogs are portalled at the same z-index and would
  // otherwise stack. See PendingSidebarDeletion.
  const [pendingDeletion, setPendingDeletion] = useState<PendingSidebarDeletion | null>(null);
  // The one session list currently in bulk-selection mode, with the rows ticked
  // in it. It lives here rather than in the list component because the delete it
  // feeds runs from this hook, and because holding a single selection is what
  // keeps a bulk delete from spanning two projects. See SidebarSessionSelection.
  const [sessionSelection, setSessionSelection] = useState<SidebarSessionSelection | null>(null);
  // The ids a bulk delete has sent and not yet heard back about. A ref, not
  // state: nothing renders from it, it only stops a second confirmation of the
  // same rows (still on screen until the first settles) from sending them again.
  const sessionIdsBeingDeletedRef = useRef<Set<string>>(new Set());
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [searchMode, setSearchMode] = useState<SidebarSearchMode>('projects');
  const [conversationResults, setConversationResults] = useState<ConversationSearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<SearchProgress | null>(null);
  const [archivedProjects, setArchivedProjects] = useState<ArchivedProjectListItem[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSessionListItem[]>([]);
  const [isArchivedSessionsLoading, setIsArchivedSessionsLoading] = useState(false);
  const [recentConversations, setRecentConversations] = useState<RecentConversationListItem[]>([]);
  const [recentConversationsTotal, setRecentConversationsTotal] = useState(0);
  const [recentConversationsHasMore, setRecentConversationsHasMore] = useState(false);
  const [isRecentConversationsLoading, setIsRecentConversationsLoading] = useState(false);
  const [isLoadingMoreRecentConversations, setIsLoadingMoreRecentConversations] = useState(false);
  const [recentConversationsError, setRecentConversationsError] = useState(false);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [optimisticStarByProjectId, setOptimisticStarByProjectId] = useState<Map<string, StarColor | null>>(new Map());
  const [optimisticGroupByProjectId, setOptimisticGroupByProjectId] = useState<Map<string, string | null>>(new Map());
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() => readCollapsedProjectGroupIds());
  const [loadingMoreProjects, setLoadingMoreProjects] = useState<Set<string>>(new Set());
  const searchSeqRef = useRef(0);
  const recentConversationsSeqRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const starToggleSequenceByProjectRef = useRef<Map<string, number>>(new Map());
  /** When each project's star was last clicked, for Gmail-style quick re-clicks. Palette picks do not touch it. */
  const lastStarClickAtByProjectRef = useRef<Map<string, number>>(new Map());
  const migrationStartedRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);

  const isSidebarCollapsed = !isMobile && !sidebarVisible;
  const activeSessionIds = activeSessions;
  const runningSessionsCount = activeSessionIds.size;

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setInitialSessionsLoaded(new Set());
  }, [projects]);

  useEffect(() => {
    // Auto-expand only when the selected project identity changes.
    // Depending on the full `selectedProject` object (or `selectedSession`) causes
    // websocket-driven list refreshes to re-open projects users manually collapsed.
    const selectedProjectId = selectedProject?.projectId;
    if (!selectedProjectId) {
      return;
    }

    setExpandedProjects((prev) => {
      if (prev.has(selectedProjectId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(selectedProjectId);
      return next;
    });
  }, [selectedProject?.projectId]);

  useEffect(() => {
    if (projects.length > 0 && !isLoading) {
      const loadedProjects = new Set<string>();
      projects.forEach((project) => {
        if (project.sessions && project.sessions.length >= 0) {
          loadedProjects.add(project.projectId);
        }
      });
      setInitialSessionsLoaded(loadedProjects);
    }
  }, [projects, isLoading]);

  // The sort order used to be polled once a second (plus a `storage` listener
  // for other tabs) because nothing announced a change. The preference store
  // notifies on every write and on every hydrate, so both are unnecessary.
  useEffect(() => {
    const loadSortOrder = () => {
      setProjectSortOrder(readProjectSortOrder());
      setStarFilter(readProjectStarFilter());
    };

    loadSortOrder();
    return subscribeToUserPreferences(loadSortOrder);
  }, []);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const fetchArchivedSessions = useCallback(async () => {
    setIsArchivedSessionsLoading(true);

    try {
      const [archivedProjectsResponse, archivedSessionsResponse] = await Promise.all([
        api.archivedProjects(),
        api.getArchivedSessions(),
      ]);

      if (!archivedProjectsResponse.ok) {
        throw new Error(`Failed to load archived projects: ${archivedProjectsResponse.status}`);
      }

      if (!archivedSessionsResponse.ok) {
        throw new Error(`Failed to load archived sessions: ${archivedSessionsResponse.status}`);
      }

      const archivedProjectsPayload = (await archivedProjectsResponse.json()) as ArchivedProjectsApiPayload;
      const archivedSessionsPayload = (await archivedSessionsResponse.json()) as ArchivedSessionsApiPayload;
      const nextProjects = Array.isArray(archivedProjectsPayload.data?.projects) ? archivedProjectsPayload.data.projects : [];
      const archivedProjectIds = new Set(nextProjects.map((project) => project.projectId));
      const nextStandaloneSessions = Array.isArray(archivedSessionsPayload.data?.sessions)
        ? archivedSessionsPayload.data.sessions.filter((session) => !session.projectId || !archivedProjectIds.has(session.projectId))
        : [];

      setArchivedProjects(nextProjects);
      setArchivedSessions(nextStandaloneSessions);
    } catch (error) {
      console.error('[Sidebar] Failed to load archived sessions:', error);
    } finally {
      setIsArchivedSessionsLoading(false);
    }
  }, []);

  const fetchRecentConversationsPage = useCallback(async (offset: number, append: boolean) => {
    const requestSequence = ++recentConversationsSeqRef.current;
    if (append) {
      setIsLoadingMoreRecentConversations(true);
    } else {
      setIsRecentConversationsLoading(true);
    }
    setRecentConversationsError(false);

    try {
      const response = await api.recentConversations({ limit: 40, offset });
      if (!response.ok) {
        throw new Error(`Failed to load recent conversations: ${response.status}`);
      }

      const payload = (await response.json()) as RecentConversationsApiPayload;
      const conversations = Array.isArray(payload.data?.conversations)
        ? payload.data.conversations
        : [];

      if (requestSequence !== recentConversationsSeqRef.current) {
        return;
      }

      setRecentConversations((previous) => {
        if (!append) {
          return conversations;
        }

        const existingIds = new Set(previous.map((conversation) => conversation.sessionId));
        return [
          ...previous,
          ...conversations.filter((conversation) => !existingIds.has(conversation.sessionId)),
        ];
      });
      setRecentConversationsTotal(Number(payload.data?.total ?? conversations.length));
      setRecentConversationsHasMore(Boolean(payload.data?.hasMore));
    } catch (error) {
      if (requestSequence !== recentConversationsSeqRef.current) {
        return;
      }
      console.error('[Sidebar] Failed to load recent conversations:', error);
      setRecentConversationsError(true);
    } finally {
      if (requestSequence === recentConversationsSeqRef.current) {
        setIsRecentConversationsLoading(false);
        setIsLoadingMoreRecentConversations(false);
      }
    }
  }, []);

  const reloadRecentConversations = useCallback(() => {
    void fetchRecentConversationsPage(0, false);
  }, [fetchRecentConversationsPage]);

  const loadMoreRecentConversations = useCallback(() => {
    if (isLoadingMoreRecentConversations || !recentConversationsHasMore) {
      return;
    }
    void fetchRecentConversationsPage(recentConversations.length, true);
  }, [
    fetchRecentConversationsPage,
    isLoadingMoreRecentConversations,
    recentConversations.length,
    recentConversationsHasMore,
  ]);

  useEffect(() => {
    if (migrationStartedRef.current) {
      return;
    }

    const legacyStarredProjectIds = readLegacyStarredProjectIds();
    if (legacyStarredProjectIds.length === 0) {
      return;
    }

    migrationStartedRef.current = true;

    const migrateLegacyStars = async () => {
      try {
        await api.migrateLegacyProjectStars(legacyStarredProjectIds);
        await onRefreshRef.current();
      } catch (error) {
        console.error('[Sidebar] Failed to migrate legacy starred projects:', error);
      } finally {
        clearLegacyStarredProjectIds();
      }
    };

    void migrateLegacyStars();
  }, [onRefresh]);

  useEffect(() => {
    void fetchArchivedSessions();
  }, [fetchArchivedSessions]);

  useEffect(() => {
    if (searchMode !== 'conversations' || debouncedSearchQuery.length >= 2) {
      return;
    }

    reloadRecentConversations();
  }, [debouncedSearchQuery, reloadRecentConversations, searchMode]);

  // The Conversations list is only fetched when its tab opens, while `projects`
  // is patched the moment a session is renamed from the workspace header. Fold
  // those title changes into the rows already loaded, or a header rename would
  // leave the highlighted conversation on its old name. The loaded rows are
  // returned as-is when no session carries a different custom name, so
  // unrelated `projects` updates do not re-render the list, and an empty
  // summary never overwrites the id the server shows for an unnamed session.
  const recentConversationsWithCurrentTitles = useMemo(() => {
    if (recentConversations.length === 0) {
      return recentConversations;
    }

    // Trimmed, because that is how the server derives a row's `sessionTitle`.
    // The status and pin travel with the title: each can change on its own.
    const metaBySessionId = new Map<string, { summary: string; status: string | null; statusSource: 'user' | 'auto' | null; pinned: boolean }>();
    for (const project of projects) {
      for (const session of project.sessions ?? []) {
        const summary = typeof session.summary === 'string' ? session.summary.trim() : '';
        metaBySessionId.set(session.id, {
          summary,
          status: session.status ?? null,
          statusSource: session.statusSource ?? null,
          pinned: Boolean(session.pinned),
        });
      }
    }

    let changed = false;
    const next = recentConversations.map((conversation) => {
      const meta = metaBySessionId.get(conversation.sessionId);
      if (meta === undefined) {
        return conversation;
      }
      // An empty summary never replaces the title the server derived.
      const sessionTitle = meta.summary || conversation.sessionTitle;
      if (
        sessionTitle === conversation.sessionTitle
        && meta.status === (conversation.status ?? null)
        && meta.statusSource === (conversation.statusSource ?? null)
        && meta.pinned === Boolean(conversation.pinned)
      ) {
        return conversation;
      }
      changed = true;
      return { ...conversation, sessionTitle, status: meta.status, statusSource: meta.statusSource, pinned: meta.pinned };
    });
    return changed ? next : recentConversations;
  }, [projects, recentConversations]);

  useEffect(() => {
    if (searchMode !== 'archived') {
      return;
    }

    // Refresh archive contents when the archived tab opens so restore actions
    // and background synchronizer updates are reflected without a full reload.
    void fetchArchivedSessions();
  }, [fetchArchivedSessions, searchMode]);

  useEffect(() => {
    setOptimisticStarByProjectId((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const next = new Map(previous);
      let changed = false;

      for (const [projectId, optimisticValue] of previous.entries()) {
        const project = projects.find((candidate) => candidate.projectId === projectId);
        if (!project) {
          next.delete(projectId);
          changed = true;
          continue;
        }

        if (getStarColor(project) === optimisticValue) {
          next.delete(projectId);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
    setOptimisticGroupByProjectId((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const next = new Map(previous);
      for (const [projectId, optimisticGroupId] of previous.entries()) {
        const project = projects.find((candidate) => candidate.projectId === projectId);
        if (!project || (project.groupId ?? null) === optimisticGroupId) {
          next.delete(projectId);
        }
      }

      return next.size === previous.size ? previous : next;
    });
  }, [projects]);

  const fetchProjectGroups = useCallback(async () => {
    try {
      const response = await api.getProjectGroups();
      if (!response.ok) {
        throw new Error(`Failed to load project groups: ${response.status}`);
      }
      const payload = (await response.json()) as ProjectGroupsApiPayload;
      setProjectGroups(Array.isArray(payload.data?.groups) ? payload.data.groups : []);
    } catch (error) {
      console.error('[Sidebar] Failed to load project groups:', error);
    }
  }, []);

  useEffect(() => {
    void fetchProjectGroups();
  }, [fetchProjectGroups]);

  // Debounce search text updates so both project filtering and conversation
  // SSE requests avoid running on every keypress.
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearchQuery(searchFilter.trim());
    }, 300);

    return () => {
      clearTimeout(timeout);
    };
  }, [searchFilter]);

  // Debounced conversation search with SSE streaming
  useEffect(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const query = debouncedSearchQuery;
    if (searchMode !== 'conversations' || query.length < 2) {
      searchSeqRef.current += 1;
      setConversationResults(null);
      setSearchProgress(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    setConversationResults(null);
    setSearchProgress(null);
    const seq = ++searchSeqRef.current;

    if (seq !== searchSeqRef.current) {
      return;
    }

    const url = api.searchConversationsUrl(query);
    const es = new EventSource(url);
    eventSourceRef.current = es;

    const accumulated: ConversationProjectResult[] = [];
    let titleResults: SessionTitleSearchResult[] = [];
    let totalMatches = 0;

    es.addEventListener('title-results', (evt) => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      try {
        const data = JSON.parse(evt.data) as { titleResults: SessionTitleSearchResult[] };
        titleResults = Array.isArray(data.titleResults) ? data.titleResults : [];
        setConversationResults({
          results: [...accumulated],
          titleResults: [...titleResults],
          totalMatches,
          query,
        });
      } catch {
        // Ignore malformed SSE data
      }
    });

    es.addEventListener('result', (evt) => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      try {
        const data = JSON.parse(evt.data) as {
          projectResult: ConversationProjectResult;
          totalMatches: number;
          scannedProjects: number;
          totalProjects: number;
        };
        accumulated.push(data.projectResult);
        totalMatches = data.totalMatches;
        setConversationResults({
          results: [...accumulated],
          titleResults: [...titleResults],
          totalMatches,
          query,
        });
        setSearchProgress({ scannedProjects: data.scannedProjects, totalProjects: data.totalProjects });
      } catch {
        // Ignore malformed SSE data
      }
    });

    es.addEventListener('progress', (evt) => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      try {
        const data = JSON.parse(evt.data) as { totalMatches: number; scannedProjects: number; totalProjects: number };
        totalMatches = data.totalMatches;
        setSearchProgress({ scannedProjects: data.scannedProjects, totalProjects: data.totalProjects });
      } catch {
        // Ignore malformed SSE data
      }
    });

    es.addEventListener('done', () => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      es.close();
      eventSourceRef.current = null;
      setIsSearching(false);
      setSearchProgress(null);
      setConversationResults({
        results: [...accumulated],
        titleResults: [...titleResults],
        totalMatches,
        query,
      });
    });

    es.addEventListener('error', () => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      es.close();
      eventSourceRef.current = null;
      setIsSearching(false);
      setSearchProgress(null);
      setConversationResults({
        results: [...accumulated],
        titleResults: [...titleResults],
        totalMatches,
        query,
      });
    });

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [debouncedSearchQuery, searchMode]);

  // All sidebar state keys (expanded, starred, loading, etc.) use the DB
  // `projectId` as their identifier after the migration.
  const toggleProject = useCallback(
    (projectId: string) => {
      // Collapsing or expanding takes the ticked rows off screen, so the
      // selection they belong to is dropped with them.
      setSessionSelection(null);

      if (searchMode === 'running') {
        setCollapsedRunningProjects((prev) => {
          const next = new Set(prev);
          if (!next.delete(projectId)) {
            next.add(projectId);
          }
          return next;
        });
        return;
      }

      setExpandedProjects((prev) => {
        const next = new Set<string>();
        if (!prev.has(projectId)) {
          next.add(projectId);
        }
        return next;
      });
    },
    [searchMode],
  );

  const isProjectExpanded = useCallback(
    (projectId: string) =>
      searchMode === 'running'
        ? !collapsedRunningProjects.has(projectId)
        : expandedProjects.has(projectId),
    [collapsedRunningProjects, expandedProjects, searchMode],
  );

  const handleSessionClick = useCallback(
    (session: SessionWithProvider, projectId: string) => {
      // Tag the session with its owning projectId so downstream handlers
      // can correlate it with the selectedProject in the app state.
      onSessionSelect({ ...session, __projectId: projectId });
    },
    [onSessionSelect],
  );

  const resolveProjectStarColor = useCallback(
    (projectId: string): StarColor | null => {
      if (optimisticStarByProjectId.has(projectId)) {
        return optimisticStarByProjectId.get(projectId) ?? null;
      }

      const project = projects.find((candidate) => candidate.projectId === projectId);
      return project ? getStarColor(project) : null;
    },
    [optimisticStarByProjectId, projects],
  );

  const setStarColor = useCallback((projectId: string, color: StarColor | null) => {
    const previousColor = resolveProjectStarColor(projectId);
    const latestSequence = (starToggleSequenceByProjectRef.current.get(projectId) ?? 0) + 1;
    starToggleSequenceByProjectRef.current.set(projectId, latestSequence);

    setOptimisticStarByProjectId((previous) => {
      const next = new Map(previous);
      next.set(projectId, color);
      return next;
    });

    const updateStar = async () => {
      try {
        const response = await api.setProjectStarColor(projectId, color);
        if (!response.ok) {
          throw new Error(await readApiErrorMessage(response, t('messages.updateProjectError')));
        }
      } catch (error) {
        // A newer click already moved on; its own request decides the color.
        if (starToggleSequenceByProjectRef.current.get(projectId) !== latestSequence) {
          return;
        }

        setOptimisticStarByProjectId((previous) => {
          const next = new Map(previous);
          next.set(projectId, previousColor);
          return next;
        });
        console.error('[Sidebar] Failed to update project star:', error);
        alert(t('messages.updateProjectError'));
      }
    };

    void updateStar();
  }, [resolveProjectStarColor, t]);

  /**
   * Gmail-style: an unstarred project turns green, a quick second click moves
   * up to the next colour, and a click after the window (or past red) unstars.
   */
  const toggleStarProject = useCallback((projectId: string) => {
    const now = Date.now();
    const lastClickAt = lastStarClickAtByProjectRef.current.get(projectId);
    lastStarClickAtByProjectRef.current.set(projectId, now);

    const msSinceLastClick = lastClickAt === undefined ? null : now - lastClickAt;
    setStarColor(projectId, starAfterClick(resolveProjectStarColor(projectId), msSinceLastClick));
  }, [resolveProjectStarColor, setStarColor]);

  const isProjectStarred = useCallback(
    (projectId: string) => resolveProjectStarColor(projectId) !== null,
    [resolveProjectStarColor],
  );

  const getProjectStarColor = useCallback(
    (projectId: string) => resolveProjectStarColor(projectId),
    [resolveProjectStarColor],
  );

  const setProjectGroup = useCallback((projectId: string, groupId: string | null) => {
    const project = projects.find((candidate) => candidate.projectId === projectId);
    const previousGroupId = optimisticGroupByProjectId.has(projectId)
      ? optimisticGroupByProjectId.get(projectId) ?? null
      : project?.groupId ?? null;

    // Held until the next project-list refresh carries the same value, like stars.
    setOptimisticGroupByProjectId((previous) => new Map(previous).set(projectId, groupId));

    const updateGroup = async () => {
      try {
        const response = await api.setProjectGroup(projectId, groupId);
        if (!response.ok) {
          throw new Error(await readApiErrorMessage(response, t('groups.saveError')));
        }
      } catch (error) {
        setOptimisticGroupByProjectId((previous) => new Map(previous).set(projectId, previousGroupId));
        console.error('[Sidebar] Failed to move project to group:', error);
        alert(error instanceof Error ? error.message : t('groups.saveError'));
      }
    };

    void updateGroup();
  }, [optimisticGroupByProjectId, projects, t]);

  const createGroupForProject = useCallback((projectId: string) => {
    const name = window.prompt(t('groups.newGroupPrompt'))?.trim();
    if (!name) {
      return;
    }

    const create = async () => {
      try {
        const response = await api.createProjectGroup(name);
        if (!response.ok) {
          throw new Error(await readApiErrorMessage(response, t('groups.saveError')));
        }
        const payload = (await response.json()) as ProjectGroupsApiPayload;
        const group = payload.data?.group;
        if (!group) {
          throw new Error(t('groups.saveError'));
        }
        setProjectGroups((previous) => [...previous, group]);
        setProjectGroup(projectId, group.groupId);
      } catch (error) {
        console.error('[Sidebar] Failed to create project group:', error);
        alert(error instanceof Error ? error.message : t('groups.saveError'));
      }
    };

    void create();
  }, [setProjectGroup, t]);

  const renameProjectGroup = useCallback((group: ProjectGroup) => {
    const name = window.prompt(t('groups.renameGroupPrompt'), group.name)?.trim();
    if (!name || name === group.name) {
      return;
    }

    const rename = async () => {
      try {
        const response = await api.renameProjectGroup(group.groupId, name);
        if (!response.ok) {
          throw new Error(await readApiErrorMessage(response, t('groups.saveError')));
        }
        setProjectGroups((previous) => previous.map((candidate) => (
          candidate.groupId === group.groupId ? { ...candidate, name } : candidate
        )));
      } catch (error) {
        console.error('[Sidebar] Failed to rename project group:', error);
        alert(error instanceof Error ? error.message : t('groups.saveError'));
      }
    };

    void rename();
  }, [t]);

  const deleteProjectGroup = useCallback((group: ProjectGroup) => {
    if (!window.confirm(t('groups.deleteGroupConfirm', { name: group.name }))) {
      return;
    }

    const remove = async () => {
      try {
        const response = await api.deleteProjectGroup(group.groupId);
        if (!response.ok) {
          throw new Error(await readApiErrorMessage(response, t('groups.saveError')));
        }
        // Members whose groupId now points nowhere render as ungrouped, which is
        // what the server did to them too.
        setProjectGroups((previous) => previous.filter((candidate) => candidate.groupId !== group.groupId));
      } catch (error) {
        console.error('[Sidebar] Failed to delete project group:', error);
        alert(error instanceof Error ? error.message : t('groups.saveError'));
      }
    };

    void remove();
  }, [t]);

  const toggleProjectGroup = useCallback((groupId: string) => {
    setCollapsedGroupIds((previous) => {
      const next = new Set(previous);
      if (!next.delete(groupId)) {
        next.add(groupId);
      }
      writeCollapsedProjectGroupIds(next);
      return next;
    });
  }, []);

  // A search shows every match, so it opens collapsed groups for its duration.
  const isProjectGroupCollapsed = useCallback(
    (groupId: string) => debouncedSearchQuery.length === 0 && collapsedGroupIds.has(groupId),
    [collapsedGroupIds, debouncedSearchQuery],
  );

  const getProjectSessions = useCallback((project: Project) => getAllSessions(project), []);

  const loadMoreSessionsForProject = useCallback(async (projectId: string) => {
    if (!onLoadMoreSessions) {
      return;
    }

    let shouldLoad = false;
    setLoadingMoreProjects((previous) => {
      if (previous.has(projectId)) {
        return previous;
      }

      shouldLoad = true;
      const next = new Set(previous);
      next.add(projectId);
      return next;
    });

    if (!shouldLoad) {
      return;
    }

    try {
      await onLoadMoreSessions(projectId);
    } catch (error) {
      console.error('[Sidebar] Failed to load more sessions:', error);
      alert(t('messages.refreshError'));
    } finally {
      setLoadingMoreProjects((previous) => {
        const next = new Set(previous);
        next.delete(projectId);
        return next;
      });
    }
  }, [onLoadMoreSessions, t]);

  const projectsWithResolvedStarState = useMemo(() => {
    if (optimisticStarByProjectId.size === 0 && optimisticGroupByProjectId.size === 0) {
      return projects;
    }

    return projects.map((project) => {
      const hasOptimisticStar = optimisticStarByProjectId.has(project.projectId);
      const hasOptimisticGroup = optimisticGroupByProjectId.has(project.projectId);
      if (!hasOptimisticStar && !hasOptimisticGroup) {
        return project;
      }

      const starColor = hasOptimisticStar
        ? optimisticStarByProjectId.get(project.projectId) ?? null
        : getStarColor(project);
      const groupId = hasOptimisticGroup
        ? optimisticGroupByProjectId.get(project.projectId) ?? null
        : project.groupId ?? null;

      return {
        ...project,
        isStarred: starColor !== null,
        starColor,
        groupId,
      };
    });
  }, [optimisticGroupByProjectId, optimisticStarByProjectId, projects]);

  const sortedProjects = useMemo(
    () => sortProjects(projectsWithResolvedStarState, projectSortOrder),
    [projectSortOrder, projectsWithResolvedStarState],
  );

  const runningProjects = useMemo(() => {
    if (activeSessionIds.size === 0) {
      return [];
    }

    return sortedProjects.reduce<Project[]>((acc, project) => {
      const sessions = (project.sessions ?? []).filter((session) => activeSessionIds.has(String(session.id)));
      const runningCount = sessions.length;

      if (runningCount === 0) {
        return acc;
      }

      acc.push({
        ...project,
        sessions,
        sessionMeta: {
          ...project.sessionMeta,
          total: runningCount,
          hasMore: false,
        },
      });
      return acc;
    }, []);
  }, [activeSessionIds, sortedProjects]);

  // The thresholds the chip can narrow to right now. One that is no longer
  // offered is shown as `all` (see normalizeStarFilter), so the chip never gets stuck.
  const starFilterChoices = useMemo(
    () => starFilterOptions(sortedProjects),
    [sortedProjects],
  );

  const effectiveStarFilter = useMemo(
    () => normalizeStarFilter(starFilter, starFilterChoices),
    [starFilterChoices, starFilter],
  );

  // The star chip lives in the Projects list only; Running and search stay unfiltered by it.
  const starFilteredProjects = useMemo(
    () => (searchMode === 'projects' ? filterProjectsByStar(sortedProjects, effectiveStarFilter) : sortedProjects),
    [effectiveStarFilter, searchMode, sortedProjects],
  );

  const isStarFilterEmpty = searchMode === 'projects' && effectiveStarFilter !== 'off' && starFilteredProjects.length === 0;

  const cycleStarFilter = useCallback(() => {
    const next = nextStarFilter(effectiveStarFilter, starFilterChoices);
    setStarFilter(next);
    writeProjectStarFilter(next);
  }, [effectiveStarFilter, starFilterChoices]);

  // One click moves starred -> A-Z -> most recent -> starred. The write
  // notifies the preference store, so Settings and other tabs follow.
  const cycleProjectSortOrder = useCallback(() => {
    const index = PROJECT_SORT_ORDERS.indexOf(projectSortOrder);
    const next = PROJECT_SORT_ORDERS[(index + 1) % PROJECT_SORT_ORDERS.length] ?? DEFAULT_PROJECT_SORT_ORDER;
    setProjectSortOrder(next);
    writeProjectSortOrder(next);
  }, [projectSortOrder]);

  const clearStarFilter = useCallback(() => {
    setStarFilter('off');
    writeProjectStarFilter('off');
  }, []);

  const filteredProjects = useMemo(
    () => filterProjects(searchMode === 'running' ? runningProjects : starFilteredProjects, debouncedSearchQuery),
    [debouncedSearchQuery, runningProjects, searchMode, starFilteredProjects],
  );

  const filteredArchivedSessions = useMemo(() => {
    const normalizedSearch = debouncedSearchQuery.trim().toLowerCase();
    if (!normalizedSearch) {
      return archivedSessions;
    }

    return archivedSessions.filter((session) => {
      const searchableFields = [
        session.sessionTitle,
        session.projectDisplayName,
        session.projectPath ?? '',
        session.provider,
      ];

      return searchableFields.some((value) => value.toLowerCase().includes(normalizedSearch));
    });
  }, [archivedSessions, debouncedSearchQuery]);

  const filteredArchivedProjects = useMemo(() => {
    const normalizedSearch = debouncedSearchQuery.trim().toLowerCase();
    if (!normalizedSearch) {
      return archivedProjects;
    }

    return archivedProjects.filter((project) => {
      const projectMatches = [
        project.displayName,
        project.fullPath || '',
      ].some((value) => value.toLowerCase().includes(normalizedSearch));

      if (projectMatches) {
        return true;
      }

      return getAllSessions(project).some((session) => {
        const sessionSummary =
          typeof session.summary === 'string' && session.summary.trim().length > 0
            ? session.summary
            : typeof session.name === 'string'
              ? session.name
              : '';

        return [
          sessionSummary,
          session.__provider,
        ].some((value) => value.toLowerCase().includes(normalizedSearch));
      });
    });
  }, [archivedProjects, debouncedSearchQuery]);

  // Keyed by projectId so the rename survives display-name mutations that arrive
  // while the input is open.
  const startEditingProject = useCallback((project: Project) => {
    setActiveRename({ target: 'project', id: project.projectId, draft: project.displayName });
  }, []);

  const startEditingSession = useCallback(
    (projectId: string, sessionId: string, initialName: string) => {
      setActiveRename({ target: 'session', id: sessionId, projectId, draft: initialName });
    },
    [],
  );

  const updateRenameDraft = useCallback((draft: string) => {
    setActiveRename((previous) => (previous ? { ...previous, draft } : previous));
  }, []);

  const cancelRename = useCallback(() => {
    setActiveRename(null);
  }, []);

  const saveProjectName = useCallback(
    // `projectId` is the DB primary key; the rename API resolves the path
    // through the `projects` table before writing the new display name.
    async (projectId: string, nextName: string) => {
      try {
        const response = await api.renameProject(projectId, nextName);
        if (response.ok) {
          await paletteOps.refreshProjects();
        } else {
          console.error('Failed to rename project');
        }
      } catch (error) {
        console.error('Error renaming project:', error);
      } finally {
        setActiveRename(null);
      }
    },
    [paletteOps],
  );

  const showDeleteSessionConfirmation = useCallback(
    (
      sessionId: string,
      sessionTitle: string,
      options: { isArchived?: boolean } = {},
    ) => {
      setPendingDeletion({
        kind: 'session',
        sessionId,
        sessionTitle,
        isArchived: Boolean(options.isArchived),
      });
    },
    [],
  );

  // Same gap as rename: nothing refetches the recents feed, so a row the user
  // just archived would stay in the list. Archiving keeps the session, so only
  // the non-archived total moves.
  const removeRecentConversation = useCallback((sessionId: string) => {
    setRecentConversations((previous) => {
      const remaining = previous.filter((conversation) => conversation.sessionId !== sessionId);
      if (remaining.length !== previous.length) {
        setRecentConversationsTotal((total) => Math.max(0, total - 1));
      }
      return remaining;
    });
  }, []);

  const confirmDeleteSession = useCallback(async (hardDelete = false) => {
    if (pendingDeletion?.kind !== 'session') {
      return;
    }

    const { sessionId } = pendingDeletion;
    setPendingDeletion(null);

    try {
      const response = await api.deleteSession(sessionId, hardDelete);

      if (response.ok) {
        onSessionDelete?.(sessionId);
        removeRecentConversation(sessionId);
        await fetchArchivedSessions();
      } else {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to delete session:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.deleteSessionFailed'));
      }
    } catch (error) {
      console.error('[Sidebar] Error deleting session:', error);
      alert(t('messages.deleteSessionError'));
    }
  }, [fetchArchivedSessions, onSessionDelete, pendingDeletion, removeRecentConversation, t]);

  const setProjectSessionSelection = useCallback((selection: SidebarSessionSelection) => {
    setSessionSelection(selection);
    // Selecting replaces the row's controls, so an open rename would be left
    // hanging behind the checkboxes with no way to save it.
    setActiveRename(null);
  }, []);

  const toggleSessionSelected = useCallback((projectId: string, sessionId: string) => {
    setSessionSelection((previous) => {
      // A row of another project starts that project's selection from scratch;
      // one selection at a time is what keeps a bulk delete inside one list.
      const sessionIds = new Set(previous?.projectId === projectId ? previous.sessionIds : []);
      if (!sessionIds.delete(sessionId)) {
        sessionIds.add(sessionId);
      }
      return { projectId, sessionIds };
    });
  }, []);

  const cancelSessionSelection = useCallback(() => {
    setSessionSelection(null);
  }, []);

  // Takes the ids instead of reading `sessionSelection`, so it stays referentially
  // stable: it is handed to every memoized project row, and re-creating it on each
  // tick of the selection would re-render all of them.
  const showDeleteSelectedSessionsConfirmation = useCallback((sessionIds: string[]) => {
    if (sessionIds.length === 0) {
      return;
    }

    setPendingDeletion({ kind: 'sessions', sessionIds });
  }, []);

  // Archives or deletes the given sessions; shared by the confirmation dialog and
  // the bulk "Archive" button, which needs no dialog since archiving is undone
  // from the archived list.
  const removeSessions = useCallback(async (requestedIds: string[], hardDelete: boolean) => {
    const selectionProjectId = sessionSelection?.projectId ?? null;
    setPendingDeletion(null);
    // Leaving selection mode as soon as the dialog is accepted takes the
    // "Delete N sessions" button away while the requests are out, so the same
    // rows cannot be confirmed twice.
    setSessionSelection(null);

    // The ids were resolved when the dialog opened, so they are checked again
    // now: a session that started a response since then is left alone (the rule
    // the rows apply), and one an earlier confirmation is still deleting is not
    // sent twice. Neither is a failure — nothing was attempted for them.
    const deletingIds = sessionIdsBeingDeletedRef.current;
    const sessionIds = requestedIds.filter(
      (sessionId) =>
        !deletingIds.has(sessionId) &&
        !(activeSessions.has(sessionId) && !backgroundSessionIds.has(sessionId)),
    );
    if (sessionIds.length === 0) {
      return;
    }
    sessionIds.forEach((sessionId) => deletingIds.add(sessionId));

    // One request per id: the endpoint deletes a single session, and settling
    // them all means one failure does not hide the sessions that did go.
    const outcomes = await Promise.allSettled(
      sessionIds.map(async (sessionId) => {
        const response = await api.deleteSession(sessionId, hardDelete);
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`status ${response.status}: ${errorText}`);
        }
        return sessionId;
      }),
    );
    sessionIds.forEach((sessionId) => deletingIds.delete(sessionId));

    const deletedSessionIds: string[] = [];
    const failedSessionIds: string[] = [];
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        deletedSessionIds.push(outcome.value);
      } else {
        failedSessionIds.push(sessionIds[index]);
        console.error('[Sidebar] Failed to delete session:', {
          sessionId: sessionIds[index],
          error: outcome.reason,
        });
      }
    });

    if (deletedSessionIds.length > 0) {
      const deletedIdSet = new Set(deletedSessionIds);
      deletedSessionIds.forEach((sessionId) => onSessionDelete?.(sessionId));
      // Same bookkeeping as the single delete, batched: the recents feed is not
      // refetched here, so the rows that just went are pruned from it by hand.
      // Counted outside the updater so both updaters stay pure: React may run an
      // updater twice, which would take the rows off the total twice.
      const removed = recentConversations.filter((conversation) => deletedIdSet.has(conversation.sessionId)).length;
      setRecentConversations((previous) =>
        previous.filter((conversation) => !deletedIdSet.has(conversation.sessionId)),
      );
      if (removed > 0) {
        setRecentConversationsTotal((total) => Math.max(0, total - removed));
      }
      await fetchArchivedSessions();
    }

    if (failedSessionIds.length > 0) {
      // The rows that could not be deleted come back ticked, ready to retry —
      // unless another selection was started while the requests were out.
      if (selectionProjectId) {
        setSessionSelection(
          (current) => current ?? { projectId: selectionProjectId, sessionIds: new Set(failedSessionIds) },
        );
      }
      alert(
        t('messages.deleteSessionsPartialFailure', {
          count: failedSessionIds.length,
          total: sessionIds.length,
        }),
      );
    }
  }, [activeSessions, backgroundSessionIds, fetchArchivedSessions, onSessionDelete, recentConversations, sessionSelection, t]);

  const confirmDeleteSessions = useCallback(async (hardDelete = false) => {
    if (pendingDeletion?.kind !== 'sessions') {
      return;
    }
    await removeSessions(pendingDeletion.sessionIds, hardDelete);
  }, [pendingDeletion, removeSessions]);

  // Read through a ref so the callback handed to every memoized project row
  // stays stable while the selection ticks.
  const removeSessionsRef = useRef(removeSessions);
  removeSessionsRef.current = removeSessions;
  const archiveSelectedSessions = useCallback((sessionIds: string[]) => {
    if (sessionIds.length === 0) {
      return;
    }
    void removeSessionsRef.current(sessionIds, false);
  }, []);

  const requestProjectDelete = useCallback(
    (project: Project) => {
      setPendingDeletion({
        kind: 'project',
        project,
        sessionCount: getProjectSessions(project).length,
      });
    },
    [getProjectSessions],
  );

  const confirmDeleteProject = useCallback(async (deleteData = false) => {
    if (pendingDeletion?.kind !== 'project') {
      return;
    }

    const { project } = pendingDeletion;

    setPendingDeletion(null);
    // Track in-flight deletes by projectId so the UI can disable actions
    // even if the project object is rebuilt while the request is flying.
    setDeletingProjects((prev) => new Set([...prev, project.projectId]));

    try {
      const response = await api.deleteProject(project.projectId, deleteData);

      if (response.ok) {
        onProjectDelete?.(project.projectId);
      } else {
        const data = (await response.json()) as { error?: string | { message?: string } };
        const err = data.error;
        const message =
          typeof err === 'string' ? err : err && typeof err === 'object' && err.message ? err.message : t('messages.deleteProjectFailed');
        alert(message);
      }
    } catch (error) {
      console.error('Error deleting project:', error);
      alert(t('messages.deleteProjectError'));
    } finally {
      setDeletingProjects((prev) => {
        const next = new Set(prev);
        next.delete(project.projectId);
        return next;
      });
    }
  }, [pendingDeletion, onProjectDelete, t]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      onProjectSelect(project);
      setCurrentProject(project);
    },
    [onProjectSelect, setCurrentProject],
  );

  const openArchivedSession = useCallback((session: ArchivedSessionListItem) => {
    const activeProject = session.projectId
      ? projects.find((candidate) => candidate.projectId === session.projectId)
      : null;
    const archivedProject = session.projectId
      ? archivedProjects.find((candidate) => candidate.projectId === session.projectId)
      : null;
    const matchingProject = activeProject ?? archivedProject ?? null;
    const sessionPayload: ProjectSession = {
      id: session.sessionId,
      summary: session.sessionTitle,
      __provider: session.provider,
      __projectId: matchingProject?.projectId ?? session.projectId ?? undefined,
    };

    // Archived sessions still need a selected project context. Active projects
    // come from the normal sidebar list, while archived-project sessions resolve
    // through the archive payload loaded by this controller.
    if (matchingProject) {
      handleProjectSelect(matchingProject);
    }

    onSessionSelect(sessionPayload);
  }, [archivedProjects, handleProjectSelect, onSessionSelect, projects]);

  const restoreArchivedProject = useCallback(async (projectId: string) => {
    try {
      const response = await api.restoreProject(projectId);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to restore project:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.restoreProjectFailed', 'Failed to restore project. Please try again.'));
        return;
      }

      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
      ]);
    } catch (error) {
      console.error('[Sidebar] Error restoring project:', error);
      alert(t('messages.restoreProjectError', 'Error restoring project. Please try again.'));
    }
  }, [fetchArchivedSessions, onRefresh, t]);

  const restoreArchivedSession = useCallback(async (sessionId: string) => {
    try {
      const response = await api.restoreSession(sessionId);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to restore session:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.restoreSessionFailed', 'Failed to restore session. Please try again.'));
        return;
      }

      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
      ]);
    } catch (error) {
      console.error('[Sidebar] Error restoring session:', error);
      alert(t('messages.restoreSessionError', 'Error restoring session. Please try again.'));
    }
  }, [fetchArchivedSessions, onRefresh, t]);

  const refreshProjects = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
        searchMode === 'conversations'
          ? fetchRecentConversationsPage(0, false)
          : Promise.resolve(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, [fetchArchivedSessions, fetchRecentConversationsPage, onRefresh, searchMode]);

  const handleQuickArchived = useCallback((sessionId: string) => {
    onSessionDelete?.(sessionId);
    removeRecentConversation(sessionId);
    void fetchArchivedSessions();
  }, [fetchArchivedSessions, onSessionDelete, removeRecentConversation]);

  const handleQuickRestored = useCallback((session: SessionWithProvider, reopen: boolean) => {
    void refreshProjects();
    if (!reopen) {
      return;
    }

    // The archive closed the session and left the project selected; select
    // the project again only if the user moved elsewhere meanwhile, since
    // selecting it also navigates away from whatever is open.
    const owningProject = session.__projectId
      ? projects.find((candidate) => candidate.projectId === session.__projectId)
      : null;
    if (owningProject && selectedProject?.projectId !== owningProject.projectId) {
      handleProjectSelect(owningProject);
    }
    onSessionSelect(session);
  }, [handleProjectSelect, onSessionSelect, projects, refreshProjects, selectedProject?.projectId]);

  const {
    notices: quickArchiveNotices,
    archiveSession: archiveSessionWithUndo,
    undoArchive: undoQuickArchiveById,
    dismissNotice: dismissQuickArchiveNotice,
  } = useQuickArchive({
    selectedSessionId: selectedSession?.id ?? null,
    onArchived: handleQuickArchived,
    onRestored: handleQuickRestored,
  });

  // One entry point for every quick-archive control: the row's icon and menu
  // item, the mobile sheet, the workspace header and the command palette.
  const quickArchiveSession = useCallback((session: ProjectSession) => {
    // The same name the row showed, so the notice reads as what was just clicked.
    const title = session.summary || session.name || t('projects.newSession');
    void archiveSessionWithUndo(session, title).then((archived) => {
      if (!archived) {
        alert(t('messages.deleteSessionFailed'));
      }
    });
  }, [archiveSessionWithUndo, t]);

  const undoQuickArchive = useCallback((noticeId: number) => {
    void undoQuickArchiveById(noticeId).then((restored) => {
      if (!restored) {
        alert(t('messages.restoreSessionFailed', 'Failed to restore session. Please try again.'));
      }
    });
  }, [t, undoQuickArchiveById]);

  const updateSessionSummary = useCallback(
    // `_projectId` and `_provider` are preserved for compatibility with
    // existing sidebar callback signatures; backend rename only needs sessionId.
    async (_projectId: string, sessionId: string, summary: string, _provider: LLMProvider) => {
      const trimmed = summary.trim();
      if (!trimmed) {
        setActiveRename(null);
        return;
      }
      try {
        const response = await api.renameSession(sessionId, trimmed);
        if (response.ok) {
          // onRefresh reloads projects, not the recents feed, so a row renamed
          // from the Conversations list kept its old title until the next fetch.
          // Patching in place also preserves the pages already loaded past the
          // first, which refetching page zero would discard.
          setRecentConversations((previous) => previous.map((conversation) => (
            conversation.sessionId === sessionId
              ? { ...conversation, sessionTitle: trimmed }
              : conversation
          )));
          await onRefresh();
        } else {
          console.error('[Sidebar] Failed to rename session:', response.status);
          alert(t('messages.renameSessionFailed'));
        }
      } catch (error) {
        console.error('[Sidebar] Error renaming session:', error);
        alert(t('messages.renameSessionError'));
      } finally {
        setActiveRename(null);
      }
    },
    [onRefresh, t],
  );

  /**
   * Pins or unpins a session. The project state is patched optimistically by
   * the caller, and the Conversations rows fold the pin in from `projects`, so
   * both lists move the row at once. A refused change is announced here.
   */
  const togglePinSession = useCallback(async (session: SessionWithProvider) => {
    if (!onSetSessionPinned) {
      return;
    }
    const saved = await onSetSessionPinned(session.id, !session.pinned);
    if (!saved) {
      alert(t('messages.pinSessionFailed'));
    }
  }, [onSetSessionPinned, t]);

  /**
   * Writes an automatic rename or status change onto every copy the sidebar
   * holds: the recents rows and, through `onSessionUpdated`, the project rows and
   * the open session. Same paths as a manual rename, without a refetch.
   */
  const applySessionMeta = useCallback((sessionId: string, patch: SessionMetaPatch) => {
    setRecentConversations((previous) => previous.map((conversation) => {
      if (conversation.sessionId !== sessionId) {
        return conversation;
      }
      return {
        ...conversation,
        ...(patch.summary !== undefined ? { sessionTitle: patch.summary } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.statusSource !== undefined ? { statusSource: patch.statusSource } : {}),
      };
    }));
    onSessionUpdated?.(sessionId, patch);
  }, [onSessionUpdated]);

  // Sessions with an auto rename already running: a second click is ignored.
  const autoRenamesInFlightRef = useRef(new Set<string>());

  const autoRenameSession = useCallback(async (session: SessionWithProvider) => {
    const sessionId = session.id;
    if (autoRenamesInFlightRef.current.has(sessionId)) {
      return;
    }
    autoRenamesInFlightRef.current.add(sessionId);
    try {
      const response = await api.autoRenameSession(sessionId);
      if (!response.ok) {
        console.error('[Sidebar] Failed to auto-rename session:', response.status);
        alert(t('messages.autoRenameFailed'));
        return;
      }
      const payload = (await response.json()) as { data?: { summary?: string; status?: string | null } };
      const summary = payload.data?.summary?.trim();
      if (!summary) {
        alert(t('messages.autoRenameFailed'));
        return;
      }
      applySessionMeta(sessionId, {
        summary,
        status: payload.data?.status ?? null,
        // The server keeps a status the user pinned; otherwise the auto run set it.
        statusSource: session.statusSource === 'user' ? 'user' : 'auto',
        nameSource: 'auto',
      });
    } catch (error) {
      console.error('[Sidebar] Error auto-renaming session:', error);
      alert(t('messages.autoRenameFailed'));
    } finally {
      autoRenamesInFlightRef.current.delete(sessionId);
    }
  }, [applySessionMeta, t]);

  /** Pins a status the user picked, or hands it back to automatic checks with null. */
  const setSessionStatus = useCallback(async (session: SessionWithProvider, status: string | null) => {
    try {
      const response = await api.setSessionStatus(session.id, status);
      if (!response.ok) {
        console.error('[Sidebar] Failed to set session status:', response.status);
        alert(t('messages.statusFailed'));
        return;
      }
      const payload = (await response.json()) as { data?: { status?: string | null; statusSource?: 'user' | 'auto' | null } };
      applySessionMeta(session.id, {
        status: payload.data?.status ?? null,
        statusSource: payload.data?.statusSource ?? null,
      });
    } catch (error) {
      console.error('[Sidebar] Error setting session status:', error);
      alert(t('messages.statusFailed'));
    }
  }, [applySessionMeta, t]);

  /**
   * Branches a session and opens the copy.
   *
   * The new row arrives over the websocket as a `session_upserted`, so nothing
   * is refetched here — the sidebar already has it by the time this navigates.
   */
  const forkSession = useCallback(
    async (session: SessionWithProvider) => {
      try {
        const response = await api.forkSession(session.id);
        const payload = await response.json();
        const forkedSessionId = payload?.data?.sessionId;
        if (!response.ok || typeof forkedSessionId !== 'string') {
          throw new Error(payload?.message || `HTTP ${response.status}`);
        }

        onSessionSelect({
          id: forkedSessionId,
          summary: payload.data.sessionName,
          __provider: session.__provider,
          __projectId: session.__projectId,
        } as ProjectSession);
      } catch (error) {
        console.error('[Sidebar] Error forking session:', error);
        alert(t('messages.forkSessionError'));
      }
    },
    [onSessionSelect, t],
  );

  const collapseSidebar = useCallback(() => {
    setSidebarVisible(false);
  }, [setSidebarVisible]);

  const expandSidebar = useCallback(() => {
    setSidebarVisible(true);
  }, [setSidebarVisible]);

  // Wrapped rather than reset from an effect: leaving the Projects tab hides the
  // ticked rows, and a selection left behind would come back with the tab.
  const changeSearchMode = useCallback((mode: SidebarSearchMode) => {
    setSessionSelection(null);
    setSearchMode(mode);
  }, []);

  return {
    isSidebarCollapsed,
    isProjectExpanded,
    activeRename,
    showNewProject,
    initialSessionsLoaded,
    currentTime,
    isRefreshing,
    searchFilter,
    deletingProjects,
    loadingMoreProjects,
    pendingDeletion,
    showVersionModal,
    filteredProjects,
    runningSessionsCount,
    archivedProjects: filteredArchivedProjects,
    archivedSessions: filteredArchivedSessions,
    archivedSessionsCount: archivedProjects.length + archivedSessions.length,
    isArchivedSessionsLoading,
    recentConversations: recentConversationsWithCurrentTitles,
    recentConversationsTotal,
    recentConversationsHasMore,
    isRecentConversationsLoading,
    isLoadingMoreRecentConversations,
    recentConversationsError,
    reloadRecentConversations,
    loadMoreRecentConversations,
    toggleProject,
    handleSessionClick,
    forkSession,
    toggleStarProject,
    setStarColor,
    isProjectStarred,
    getProjectStarColor,
    // Groups only shape the Projects list; Running stays one flat list.
    projectGroups: searchMode === 'projects' ? projectGroups : EMPTY_PROJECT_GROUPS,
    allProjectGroups: projectGroups,
    setProjectGroup,
    createGroupForProject,
    renameProjectGroup,
    deleteProjectGroup,
    toggleProjectGroup,
    isProjectGroupCollapsed,
    getProjectSessions,
    loadMoreSessionsForProject,
    startEditingProject,
    startEditingSession,
    updateRenameDraft,
    cancelRename,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    sessionSelection,
    setProjectSessionSelection,
    toggleSessionSelected,
    cancelSessionSelection,
    showDeleteSelectedSessionsConfirmation,
    confirmDeleteSessions,
    archiveSelectedSessions,
    requestProjectDelete,
    confirmDeleteProject,
    handleProjectSelect,
    openArchivedSession,
    restoreArchivedProject,
    restoreArchivedSession,
    refreshProjects,
    quickArchiveNotices,
    quickArchiveSession,
    undoQuickArchive,
    dismissQuickArchiveNotice,
    updateSessionSummary,
    togglePinSession,
    autoRenameSession,
    setSessionStatus,
    collapseSidebar,
    expandSidebar,
    setShowNewProject,
    searchMode,
    setSearchMode: changeSearchMode,
    conversationResults,
    isSearching,
    searchProgress,
    clearConversationResults: useCallback(() => {
      searchSeqRef.current += 1;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setIsSearching(false);
      setSearchProgress(null);
      setConversationResults(null);
    }, []),
    setSearchFilter,
    starFilter: effectiveStarFilter,
    cycleStarFilter,
    clearStarFilter,
    isStarFilterEmpty,
    projectSortOrder,
    cycleProjectSortOrder,
    setPendingDeletion,
    setShowVersionModal,
  };
}
