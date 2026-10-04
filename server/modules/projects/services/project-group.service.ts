import { projectGroupsDb, projectsDb } from '@/modules/database/index.js';
import type { ProjectGroupRow } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

export type ProjectGroupView = {
  groupId: string;
  name: string;
};

const MAX_GROUP_NAME_LENGTH = 80;

function toView(row: ProjectGroupRow): ProjectGroupView {
  return { groupId: row.group_id, name: row.name };
}

function normalizeGroupName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    throw new AppError('Group name is required', { code: 'GROUP_NAME_REQUIRED', statusCode: 400 });
  }
  if (trimmed.length > MAX_GROUP_NAME_LENGTH) {
    throw new AppError(`Group name must be at most ${MAX_GROUP_NAME_LENGTH} characters`, {
      code: 'GROUP_NAME_TOO_LONG',
      statusCode: 400,
    });
  }
  return trimmed;
}

function requireGroup(groupId: string): ProjectGroupRow {
  const group = projectGroupsDb.getGroupById(groupId.trim());
  if (!group) {
    throw new AppError('Group not found', { code: 'GROUP_NOT_FOUND', statusCode: 404 });
  }
  return group;
}

function assertNameFree(name: string, exceptGroupId?: string): void {
  const existing = projectGroupsDb.getGroupByName(name);
  if (existing && existing.group_id !== exceptGroupId) {
    throw new AppError(`A group named "${existing.name}" already exists`, {
      code: 'GROUP_NAME_TAKEN',
      statusCode: 409,
    });
  }
}

export function listProjectGroups(): ProjectGroupView[] {
  return projectGroupsDb.listGroups().map(toView);
}

export function createProjectGroup(name: unknown): ProjectGroupView {
  const normalizedName = normalizeGroupName(name);
  assertNameFree(normalizedName);
  return toView(projectGroupsDb.createGroup(normalizedName));
}

export function renameProjectGroup(groupId: string, name: unknown): ProjectGroupView {
  const group = requireGroup(groupId);
  const normalizedName = normalizeGroupName(name);
  assertNameFree(normalizedName, group.group_id);
  projectGroupsDb.renameGroup(group.group_id, normalizedName);
  return { groupId: group.group_id, name: normalizedName };
}

export function deleteProjectGroup(groupId: string): void {
  const group = requireGroup(groupId);
  projectGroupsDb.deleteGroup(group.group_id);
}

/** Files a project under a group, or ungroups it when `groupId` is null. */
export function setProjectGroup(projectId: string, groupId: unknown): { groupId: string | null } {
  if (groupId !== null && typeof groupId !== 'string') {
    throw new AppError('groupId must be a string or null', { code: 'INVALID_GROUP_ID', statusCode: 400 });
  }

  const project = projectsDb.getProjectById(projectId.trim());
  if (!project) {
    throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }

  const nextGroupId = groupId === null ? null : requireGroup(groupId).group_id;
  projectsDb.updateProjectGroupById(project.project_id, nextGroupId);
  return { groupId: nextGroupId };
}
