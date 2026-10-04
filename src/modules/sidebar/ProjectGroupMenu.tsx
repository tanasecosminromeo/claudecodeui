import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, Folder, FolderMinus, FolderPlus } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '@/shared/utils';
import type { ProjectGroup } from '@/shared/types';

type ProjectGroupMenuProps = {
  anchor: { x: number; y: number };
  groups: ProjectGroup[];
  currentGroupId: string | null;
  onMove: (groupId: string | null) => void;
  onCreate: () => void;
  onClose: () => void;
  t: TFunction;
};

const MENU_WIDTH = 220;
const ITEM_HEIGHT = 36;

/**
 * "Move to group" for one project row. Opened at the click point and portalled,
 * because the desktop row is itself a button and cannot nest the shared
 * ActionMenu's trigger.
 */
export default function ProjectGroupMenu({
  anchor,
  groups,
  currentGroupId,
  onMove,
  onCreate,
  onClose,
  t,
}: ProjectGroupMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const itemCount = groups.length + 1 + (currentGroupId ? 1 : 0);
  const height = itemCount * ITEM_HEIGHT + 40;
  const left = Math.max(8, Math.min(anchor.x - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(anchor.y + 8, window.innerHeight - height - 8));

  const select = (action: () => void) => {
    action();
    onClose();
  };

  const itemClassName =
    'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent';

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('groups.moveToGroup')}
      data-testid="project-group-menu"
      className="fixed z-[100] max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl"
      style={{ left, top, width: MENU_WIDTH }}
      onClick={(event) => event.stopPropagation()}
    >
      <p className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t('groups.moveToGroup')}
      </p>
      {groups.map((group) => (
        <button
          key={group.groupId}
          type="button"
          role="menuitemradio"
          aria-checked={currentGroupId === group.groupId}
          className={itemClassName}
          onClick={() => select(() => onMove(group.groupId))}
        >
          <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{group.name}</span>
          {currentGroupId === group.groupId && <Check className="h-3.5 w-3.5 text-primary" />}
        </button>
      ))}
      <button
        type="button"
        role="menuitem"
        className={cn(itemClassName, groups.length > 0 && 'mt-1 border-t border-border pt-2')}
        onClick={() => select(onCreate)}
      >
        <FolderPlus className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span>{t('groups.newGroup')}</span>
      </button>
      {currentGroupId && (
        <button
          type="button"
          role="menuitem"
          className={itemClassName}
          onClick={() => select(() => onMove(null))}
        >
          <FolderMinus className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <span>{t('groups.removeFromGroup')}</span>
        </button>
      )}
    </div>,
    document.body,
  );
}
