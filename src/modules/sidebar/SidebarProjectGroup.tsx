import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Edit3, Folder, FolderOpen, MoreHorizontal, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { ProjectGroup } from '@/shared/types';

type SidebarProjectGroupProps = {
  group: ProjectGroup;
  projectCount: number;
  isCollapsed: boolean;
  onToggle: (groupId: string) => void;
  onRename: (group: ProjectGroup) => void;
  onDelete: (group: ProjectGroup) => void;
  children: ReactNode;
  t: TFunction;
};

/** Rendered by SidebarProjectList for one named folder of projects, with its rows indented beneath it. */
export default function SidebarProjectGroup({
  group,
  projectCount,
  isCollapsed,
  onToggle,
  onRename,
  onDelete,
  children,
  t,
}: SidebarProjectGroupProps) {
  const FolderIcon = isCollapsed ? Folder : FolderOpen;

  return (
    <section data-testid="project-group" data-group-name={group.name} className="md:space-y-1">
      <div className="group/project-group mx-1 flex items-center gap-1 rounded-md hover:bg-accent/50">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
          onClick={() => onToggle(group.groupId)}
          aria-expanded={!isCollapsed}
          data-testid="project-group-toggle"
        >
          {isCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          )}
          <FolderIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {group.name}
          </span>
          <span className="flex-shrink-0 text-[11px] text-muted-foreground/70">
            {t('groups.projectCount', { count: projectCount })}
          </span>
        </button>
        <ActionMenu
          label={t('groups.groupOptions')}
          ariaLabel={`${t('groups.groupOptions')}: ${group.name}`}
          icon={MoreHorizontal}
          iconOnly
          portal
          variant="ghost"
          size="icon"
          triggerClassName="h-6 w-6 text-muted-foreground opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 group-hover/project-group:opacity-70 touch:opacity-70"
          menuClassName="w-[200px] rounded-xl p-1.5 shadow-xl"
          items={[
            {
              key: 'rename',
              label: t('groups.renameGroup'),
              icon: Edit3,
              onSelect: () => onRename(group),
            },
            {
              key: 'delete',
              label: t('groups.deleteGroup'),
              icon: Trash2,
              isDanger: true,
              onSelect: () => onDelete(group),
            },
          ]}
        />
      </div>
      {!isCollapsed && (
        <div className={cn('ml-3 border-l border-border/60 pl-1')}>
          {children}
        </div>
      )}
    </section>
  );
}
