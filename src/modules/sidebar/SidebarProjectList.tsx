import { Fragment, useEffect, useMemo } from 'react';

import type { SidebarProjectListProps } from '@/shared/types';
import { getPageTitle } from '@/shared/utils';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';
import SidebarProjectsState from '@/modules/sidebar/SidebarProjectsState';
import SidebarProjectGroup from '@/modules/sidebar/SidebarProjectGroup';
import { buildProjectSections } from '@/modules/sidebar/utils/sidebarProjectFormatting';


/** Rendered by SidebarContent to list the filtered projects, delegating each row to SidebarProjectItem. */
export default function SidebarProjectList({
  projects,
  filteredProjects,
  selectedProject,
  selectedSession,
  isLoading,
  loadingProgress,
  isProjectExpanded,
  activeRename,
  initialSessionsLoaded,
  currentTime,

  deletingProjects,
  tasksEnabled,
  mcpServerStatus,
  getProjectSessions,
  onLoadMoreSessions,
  loadingMoreProjects,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  getProjectStarColor,
  projectGroups,
  allProjectGroups,
  isProjectGroupCollapsed,
  onToggleProjectGroup,
  onRenameProjectGroup,
  onDeleteProjectGroup,
  onSetProjectGroup,
  onCreateGroupForProject,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onSetStarColor,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onArchiveSession,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectListProps) {
  const pageTitle = getPageTitle(selectedProject, selectedSession);
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;
  const sections = useMemo(
    () => buildProjectSections(filteredProjects, projectGroups),
    [filteredProjects, projectGroups],
  );

  return (
      <div className="pb-safe-area-inset-bottom md:space-y-1">
        {!showProjects
          ? state
          : sections.map(({ group, projects: sectionProjects }) => {
            const rows = sectionProjects.map((project) => {
              // Both renames are resolved here rather than inside the row, so
              // every other row is handed the same scalars on each keystroke and
              // its memo boundary holds.
              const renamingProject =
                activeRename?.target === 'project' && activeRename.id === project.projectId
                  ? activeRename
                  : null;
              const renamingSession =
                activeRename?.target === 'session' && activeRename.projectId === project.projectId
                  ? activeRename
                  : null;

              // React key + per-project state lookups all use the DB `projectId`
              // so they remain stable across renames and session changes.
              return (
              <SidebarProjectItem
                key={project.projectId}
                project={project}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                isExpanded={isProjectExpanded(project.projectId)}
                isDeleting={deletingProjects.has(project.projectId)}
                starColor={getProjectStarColor(project.projectId)}
                projectGroups={allProjectGroups}
                isEditing={renamingProject !== null}
                renameDraft={renamingProject?.draft ?? ''}
                sessions={getProjectSessions(project)}
                initialSessionsLoaded={initialSessionsLoaded.has(project.projectId)}
                isLoadingMoreSessions={loadingMoreProjects.has(project.projectId)}
                currentTime={currentTime}
                sessionRenameId={renamingSession?.id ?? null}
                sessionRenameDraft={renamingSession?.draft ?? ''}
                tasksEnabled={tasksEnabled}
                mcpServerStatus={mcpServerStatus}
                onRenameDraftChange={onRenameDraftChange}
                onToggleProject={onToggleProject}
                onProjectSelect={onProjectSelect}
                onToggleStarProject={onToggleStarProject}
                onSetStarColor={onSetStarColor}
                onSetProjectGroup={onSetProjectGroup}
                onCreateGroupForProject={onCreateGroupForProject}
                onStartEditingProject={onStartEditingProject}
                onCancelEditingProject={onCancelEditingProject}
                onSaveProjectName={onSaveProjectName}
                onDeleteProject={onDeleteProject}
                onSessionSelect={onSessionSelect}
                onDeleteSession={onDeleteSession}
                onForkSession={onForkSession}
                onArchiveSession={onArchiveSession}
                onLoadMoreSessions={onLoadMoreSessions}
                activeSessions={activeSessions}
                backgroundSessionIds={backgroundSessionIds}
                attentionSessionIds={attentionSessionIds}
                onNewSession={onNewSession}
                onStartEditingSession={onStartEditingSession}
                onCancelEditingSession={onCancelEditingSession}
                onSaveEditingSession={onSaveEditingSession}
                t={t}
              />
            );
            });

            if (!group) {
              return <Fragment key="ungrouped">{rows}</Fragment>;
            }

            return (
              <SidebarProjectGroup
                key={group.groupId}
                group={group}
                projectCount={sectionProjects.length}
                isCollapsed={isProjectGroupCollapsed(group.groupId)}
                onToggle={onToggleProjectGroup}
                onRename={onRenameProjectGroup}
                onDelete={onDeleteProjectGroup}
                t={t}
              >
                {rows}
              </SidebarProjectGroup>
            );
          })}
    </div>
  );
}
