import type { TFunction } from 'i18next';

import type {
  LLMProvider,
  Project,
  ProjectGroup,
  ProjectSession,
  ProjectSortOrder,
  SessionWithProvider,
  SettingsProject,
} from '@/shared/types';
import { getStarColor } from '@/modules/sidebar/utils/starColors';

// Presentation data the sidebar derives from a session before rendering its row.
type SessionViewModel = {
  isActive: boolean;
  sessionName: string;
  sessionTime: string;
  messageCount: number;
};

export const formatCompactAge = (
  dateString: string | null | undefined,
  currentTime: Date,
): string => {
  if (!dateString) return '';

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';

  const minutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}hr` : `${Math.floor(hours / 24)}d`;
};

const getCreatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.lastActivity || '');
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : 'claude';
};

const getSessionDate = (session: SessionWithProvider): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return session.summary || session.name || t('projects.newSession');
};

const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isActive: diffInMinutes < 10,
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

/**
 * Cached against the project object, not its id.
 *
 * Every sidebar render asks for each project's sessions, and this builds a new
 * array of new session objects. Without the cache the array is a different
 * reference each time, which is enough on its own to defeat the memo boundary
 * on every project and session row. `useProjectsState` always replaces a
 * project rather than mutating it, so a stale entry is unreachable: a changed
 * project is a different key.
 */
const sortedSessionsByProject = new WeakMap<Project, SessionWithProvider[]>();

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  const cached = sortedSessionsByProject.get(project);
  if (cached) {
    return cached;
  }

  const sessions = (project.sessions || []).map((session) => ({
    ...session,
    __provider: getSessionProvider(session),
  })).sort(
    // Pinned sessions first, then newest first within each group.
    (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      || getSessionDate(b).getTime() - getSessionDate(a).getTime(),
  );

  sortedSessionsByProject.set(project, sessions);
  return sessions;
};

const getProjectLastActivity = (project: Project): Date => {
  const sessions = getAllSessions(project);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

/**
 * Orders projects by one of three rules:
 * - `starred`: every starred project (any colour) before the unstarred ones,
 *   each block alphabetical. Colour never changes the order.
 * - `name`: alphabetical.
 * - `date`: most recent activity first.
 */
export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] => {
  const sorted = [...projects];

  sorted.sort((projectA, projectB) => {
    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    if (projectSortOrder === 'starred') {
      const starRankA = getStarColor(projectA) === null ? 1 : 0;
      const starRankB = getStarColor(projectB) === null ? 1 : 0;
      if (starRankA !== starRankB) {
        return starRankA - starRankB;
      }
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return sorted;
};

export type ProjectSection = {
  /** null for the trailing block of ungrouped projects. */
  group: ProjectGroup | null;
  projects: Project[];
};

/**
 * Splits an already-sorted project list into sidebar folders: groups by name
 * first, then the ungrouped projects. Each section keeps the incoming order,
 * and groups with no (visible) projects are left out. A `groupId` pointing at
 * a group the client does not know yet counts as ungrouped.
 */
export const buildProjectSections = (sortedProjects: Project[], groups: ProjectGroup[]): ProjectSection[] => {
  const projectsByGroupId = new Map<string, Project[]>(groups.map((group) => [group.groupId, []]));
  const ungrouped: Project[] = [];

  for (const project of sortedProjects) {
    const bucket = project.groupId ? projectsByGroupId.get(project.groupId) : undefined;
    if (bucket) {
      bucket.push(project);
    } else {
      ungrouped.push(project);
    }
  }

  const sections: ProjectSection[] = [...groups]
    .sort((groupA, groupB) => groupA.name.localeCompare(groupB.name, undefined, { sensitivity: 'base' }))
    .map((group) => ({ group, projects: projectsByGroupId.get(group.groupId) ?? [] }))
    .filter((section) => section.projects.length > 0);

  if (ungrouped.length > 0) {
    sections.push({ group: null, projects: ungrouped });
  }

  return sections;
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = (project.displayName || project.projectId).toLowerCase();
    // `project.path`/`fullPath` is the most useful search target now that the
    // folder-derived name is gone; fall back to displayName above.
    const searchPath = (project.path || project.fullPath || '').toLowerCase();
    return displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch);
  });
};

/** Keeps only starred projects, of any colour. Colour never narrows the list. */
export const filterStarredProjects = (projects: Project[]): Project[] => (
  projects.filter((project) => getStarColor(project) !== null)
);

/** How long after its last message a session still counts as recent in the Focus view. */
const FOCUS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A session is recent when it is processing now (a Monitor or background shell
 * keeps it in `activeSessions` however old its last message is), or its last
 * interaction is within the Focus window.
 */
export const isSessionRecent = (
  session: SessionWithProvider,
  activeSessions: ReadonlySet<string>,
  now: Date,
): boolean => (
  activeSessions.has(String(session.id))
  || now.getTime() - getSessionDate(session).getTime() <= FOCUS_WINDOW_MS
);

/**
 * Keeps the projects with at least one recent session. Each one is a new copy
 * listing only its recent sessions, the same trimming the Running view does.
 */
export const filterProjectsToFocus = (
  projects: Project[],
  activeSessions: ReadonlySet<string>,
  now: Date,
): Project[] => projects.reduce<Project[]>((acc, project) => {
  const sessions = getAllSessions(project).filter((session) => isSessionRecent(session, activeSessions, now));
  if (sessions.length === 0) {
    return acc;
  }

  acc.push({
    ...project,
    sessions,
    sessionMeta: {
      ...project.sessionMeta,
      total: sessions.length,
      hasMore: false,
    },
  });
  return acc;
}, []);

export const getTaskIndicatorStatus = (
  project: Project,
  mcpServerStatus: { hasMCPServer?: boolean; isConfigured?: boolean } | null,
) => {
  const projectConfigured = Boolean(project.taskmaster?.hasTaskmaster);
  const mcpConfigured = Boolean(mcpServerStatus?.hasMCPServer && mcpServerStatus?.isConfigured);

  if (projectConfigured && mcpConfigured) {
    return 'fully-configured';
  }

  if (projectConfigured) {
    return 'taskmaster-only';
  }

  if (mcpConfigured) {
    return 'mcp-only';
  }

  return 'not-configured';
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};

/** Display names for the providers a session row can belong to. */
export const PROVIDER_LABELS: Record<LLMProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};
