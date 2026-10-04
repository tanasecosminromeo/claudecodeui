import type { ProjectSortOrder } from '@/shared/types';
import { readUserPreference } from '@/shared/userSettings';

export const readProjectSortOrder = (): ProjectSortOrder => (
  readUserPreference<ProjectSortOrder>('projectSortOrder', 'name') === 'date' ? 'date' : 'name'
);

const LEGACY_STARRED_PROJECTS_STORAGE_KEY = 'starredProjects';

/**
 * Reads legacy project stars from localStorage (used only for one-time migration to backend).
 */
export const readLegacyStarredProjectIds = (): string[] => {
  try {
    const saved = localStorage.getItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

/**
 * Clears the legacy localStorage stars key after migration to backend completes.
 */
export const clearLegacyStarredProjectIds = () => {
  try {
    localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

const COLLAPSED_PROJECT_GROUPS_STORAGE_KEY = 'collapsedProjectGroups';

/** Group ids the user collapsed in the Projects list. A per-device view choice, so localStorage. */
export const readCollapsedProjectGroupIds = (): Set<string> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
};

export const writeCollapsedProjectGroupIds = (groupIds: ReadonlySet<string>) => {
  try {
    localStorage.setItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY, JSON.stringify([...groupIds]));
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};
