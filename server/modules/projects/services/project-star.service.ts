import { projectsDb } from '@/modules/database/index.js';
import type { StarColor } from '@/shared/types.js';
import { AppError, parseStarColor, STAR_COLORS } from '@/shared/utils.js';

type ToggleProjectStarResult = {
  isStarred: boolean;
};

type SetProjectStarColorResult = {
  starColor: StarColor | null;
};

type ApplyLegacyStarredProjectIdsResult = {
  updated: number;
};

function normalizeProjectId(projectId: string): string {
  return projectId.trim();
}

function uniqueProjectIds(projectIds: string[]): string[] {
  const uniqueIds = new Set<string>();
  for (const projectId of projectIds) {
    const normalizedProjectId = normalizeProjectId(projectId);
    if (!normalizedProjectId) {
      continue;
    }
    uniqueIds.add(normalizedProjectId);
  }
  return [...uniqueIds];
}

/**
 * Applies legacy `localStorage` stars keyed by DB `projectId` onto `projects.isStarred`.
 *
 * The operation is idempotent: already-starred projects are ignored, unknown ids are skipped.
 */
export function applyLegacyStarredProjectIds(projectIds: string[]): ApplyLegacyStarredProjectIdsResult {
  const normalizedProjectIds = uniqueProjectIds(projectIds);
  let updated = 0;

  for (const projectId of normalizedProjectIds) {
    const project = projectsDb.getProjectById(projectId);
    if (!project) {
      continue;
    }

    if (project.isStarred) {
      continue;
    }

    projectsDb.updateProjectIsStarredById(projectId, true);
    updated += 1;
  }

  return { updated };
}

function requireProject(projectId: string) {
  const normalizedProjectId = normalizeProjectId(projectId);
  if (!normalizedProjectId) {
    throw new AppError('projectId is required', {
      code: 'PROJECT_ID_REQUIRED',
      statusCode: 400,
    });
  }

  const project = projectsDb.getProjectById(normalizedProjectId);
  if (!project) {
    throw new AppError('Project not found', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  return project;
}

/**
 * Sets one project's star color; `null` removes the star.
 */
export function setProjectStarColor(projectId: string, color: unknown): SetProjectStarColorResult {
  if (color !== null && parseStarColor(color) === null) {
    throw new AppError(`color must be one of ${STAR_COLORS.join(', ')} or null`, {
      code: 'INVALID_STAR_COLOR',
      statusCode: 400,
    });
  }

  const project = requireProject(projectId);
  const starColor = parseStarColor(color);
  projectsDb.updateProjectStarColorById(project.project_id, starColor);
  return { starColor };
}

/**
 * Flips `projects.isStarred` for one project and returns the new state.
 */
export function toggleProjectStar(projectId: string): ToggleProjectStarResult {
  const normalizedProjectId = normalizeProjectId(projectId);
  if (!normalizedProjectId) {
    throw new AppError('projectId is required', {
      code: 'PROJECT_ID_REQUIRED',
      statusCode: 400,
    });
  }

  const project = projectsDb.getProjectById(normalizedProjectId);
  if (!project) {
    throw new AppError('Project not found', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const nextStarredState = !project.isStarred;
  projectsDb.updateProjectIsStarredById(normalizedProjectId, nextStarredState);

  return { isStarred: nextStarredState };
}
