import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FileX, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { UnresolvedFileReference } from '@/modules/project-workspace/hooks/useFileOpenResolver';

// Long enough to read a path and copy it; it also has a close button.
const AUTO_DISMISS_MS = 10_000;

type FileLinkNoticeProps = {
  notice: UnresolvedFileReference | null;
  onDismiss: () => void;
};

/**
 * Rendered by WorkspaceMain when a file link in chat names no readable file,
 * in place of an editor that would only say "File not found". A file that
 * exists outside the project gets the setting that would make it readable.
 *
 * Placed like QuickArchiveNotices: bottom-right on desktop, above the composer
 * on phones.
 */
export default function FileLinkNotice({ notice, onDismiss }: FileLinkNoticeProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!notice) {
      return undefined;
    }
    const timer = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);

  if (!notice || typeof document === 'undefined') {
    return null;
  }

  const shownPath = notice.blockedPath ?? notice.reference;

  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-[5.5rem] z-[60] flex flex-col items-stretch sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[26rem]"
    >
      <div
        role="status"
        data-testid="file-link-notice"
        className="animate-in slide-in-from-bottom-2 pointer-events-auto flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground shadow-lg"
      >
        <FileX className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {notice.blockedPath
              ? t('fileLink.outsideRoots', 'This file is outside the project')
              : t('fileLink.notFound', 'File not found')}
          </div>
          <div className="break-all font-mono text-xs text-muted-foreground" title={shownPath}>
            {shownPath}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {notice.blockedPath
              ? t(
                  'fileLink.outsideRootsHint',
                  'Add its folder to CLOUDCLI_READ_ONLY_ROOTS on the server to open files there.',
                )
              : t(
                  'fileLink.notFoundHint',
                  'Not in this project, and not next to any path the message mentions.',
                )}
          </div>
        </div>
        <button
          type="button"
          aria-label={t('fileLink.dismiss', 'Dismiss')}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
