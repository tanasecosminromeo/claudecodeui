import { createPortal } from 'react-dom';
import { Archive, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import type { QuickArchiveNotice } from '@/shared/types';

type QuickArchiveNoticesProps = {
  notices: QuickArchiveNotice[];
  onUndo: (noticeId: number) => void;
  onDismiss: (noticeId: number) => void;
  t: TFunction;
};

/**
 * Rendered by Sidebar: the "Archived <session>" notices with their Undo, one
 * per quick archive still within its undo window.
 *
 * Portalled to the body so it shows wherever the archive was started from —
 * the sidebar may be collapsed to its rail, or be the closed drawer on mobile.
 * Bottom-right on desktop like the file tree's toast; above the composer on
 * phones, where the bottom-right corner is the Send button.
 */
export default function QuickArchiveNotices({ notices, onUndo, onDismiss, t }: QuickArchiveNoticesProps) {
  if (notices.length === 0 || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-[5.5rem] z-[60] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[22rem]"
    >
      {notices.map((notice) => (
        <div
          key={notice.id}
          role="status"
          data-testid="quick-archive-notice"
          className="animate-in slide-in-from-bottom-2 pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground shadow-lg"
        >
          <Archive className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {t('quickArchive.archived', 'Archived')}{' '}
            <span className="font-medium" title={notice.title}>{notice.title}</span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 flex-shrink-0 px-2 text-primary hover:text-primary"
            onClick={() => onUndo(notice.id)}
          >
            {t('quickArchive.undo', 'Undo')}
          </Button>
          <button
            type="button"
            aria-label={t('quickArchive.dismiss', 'Dismiss')}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onDismiss(notice.id)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
