import type { ProjectSortOrder, StarFilter } from '@/shared/types';
import {
  DEFAULT_PROJECT_SORT_ORDER,
  parseProjectSortOrder,
  readUserPreference,
  writeUserPreference,
} from '@/shared/userSettings';
import { isStarColor } from '@/modules/sidebar/utils/starColors';

/** Unknown or missing values read as the default, 'starred'. */
export const readProjectSortOrder = (): ProjectSortOrder => (
  parseProjectSortOrder(readUserPreference<unknown>('projectSortOrder', DEFAULT_PROJECT_SORT_ORDER))
);

export const writeProjectSortOrder = (order: ProjectSortOrder) => {
  writeUserPreference('projectSortOrder', order);
};

/** The starred-filter chip, kept on the user's account like the sort order. Unknown values read as off. */
export const readProjectStarFilter = (): StarFilter => {
  const stored = readUserPreference<unknown>('projectStarFilter', 'off');
  if (stored === 'off' || stored === 'all' || isStarColor(stored)) {
    return stored;
  }
  return 'off';
};

export const writeProjectStarFilter = (filter: StarFilter) => {
  writeUserPreference('projectStarFilter', filter);
};

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
