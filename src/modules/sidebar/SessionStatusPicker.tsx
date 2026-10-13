import { useEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { Check } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '@/shared/utils';
import {
  SESSION_STATUS_EMOJI,
  SESSION_STATUS_KEYS,
  getSessionStatusEmoji,
  type SessionStatusKey,
} from '@/modules/sidebar/utils/sessionStatus';

type SessionStatusListProps = {
  status: string | null;
  statusSource: 'user' | 'auto' | null;
  /** Receives a key to pin it, or null for "Auto". */
  onPick: (status: SessionStatusKey | null) => void;
  t: TFunction;
};

/**
 * "Auto" plus the ten statuses. "Auto" is checked whenever the status is not
 * pinned by the user; a status is checked only when the user pinned it.
 */
export function SessionStatusList({ status, statusSource, onPick, t }: SessionStatusListProps) {
  const isPinned = statusSource === 'user';
  const itemClassName = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent focus:outline-none focus-visible:bg-accent';

  return (
    <div role="menu" aria-label={t('sessionStatus.setStatus')} className="flex flex-col">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={!isPinned}
        className={itemClassName}
        onClick={() => onPick(null)}
      >
        <span className="w-4 text-center" aria-hidden="true" />
        <span className="flex-1">{t('sessionStatus.auto')}</span>
        {!isPinned && <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
      </button>
      {SESSION_STATUS_KEYS.map((key) => {
        const isChecked = isPinned && status === key;
        return (
          <button
            key={key}
            type="button"
            role="menuitemradio"
            aria-checked={isChecked}
            className={itemClassName}
            onClick={() => onPick(key)}
          >
            <span className="w-4 text-center" aria-hidden="true">{SESSION_STATUS_EMOJI[key]}</span>
            <span className="flex-1">{t(`sessionStatus.${key}`)}</span>
            {isChecked && <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

type SessionStatusPopoverProps = SessionStatusListProps & {
  open: boolean;
  onClose: () => void;
};

/**
 * The desktop status picker, anchored under a row. Closes on a pick, on a click
 * outside it, and on Escape. The row places it inside its own `relative` box.
 */
export function SessionStatusPopover({ open, onClose, status, statusSource, onPick, t }: SessionStatusPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutsidePointer = (event: globalThis.MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      ref={popoverRef}
      className="absolute left-2 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      onClick={(event) => event.stopPropagation()}
    >
      <SessionStatusList
        status={status}
        statusSource={statusSource}
        onPick={(nextStatus) => {
          onPick(nextStatus);
          onClose();
        }}
        t={t}
      />
    </div>
  );
}

type SessionStatusEmojiProps = {
  status: string | null;
  t: TFunction;
  /**
   * Makes the slot a control that opens the picker. Omitted in rows where the
   * status is display only; then a session without a status renders nothing.
   */
  onActivate?: () => void;
};

/**
 * The status emoji in front of a session title. It is a fixed 16px slot so
 * titles line up, and it is never part of the name itself, so rename, search
 * and copy do not see it.
 */
export function SessionStatusEmoji({ status, t, onActivate }: SessionStatusEmojiProps) {
  const emoji = getSessionStatusEmoji(status);
  if (!emoji && !onActivate) {
    return null;
  }

  const label = emoji
    ? t('sessionStatus.statusLabel', { label: t(`sessionStatus.${status}`) })
    : t('sessionStatus.setStatus');

  if (!onActivate) {
    return (
      <span role="img" aria-label={label} title={label} className="inline-flex w-4 flex-shrink-0 justify-center text-sm leading-none">
        {emoji}
      </span>
    );
  }

  // A span rather than a button: the desktop row is an anchor, and a button
  // inside it is invalid markup. Enter and Space activate it instead.
  const handleActivate = (event: MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      onActivate();
    }
  };

  return (
    <span
      role="button"
      tabIndex={0}
      aria-haspopup="menu"
      aria-label={label}
      title={label}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex w-4 flex-shrink-0 cursor-pointer justify-center rounded text-sm leading-none hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
        !emoji && 'text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
      )}
    >
      {emoji ?? '·'}
    </span>
  );
}
