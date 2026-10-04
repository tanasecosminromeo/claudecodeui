import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Star, StarOff } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '@/shared/utils';
import type { StarColor } from '@/shared/types';
import { STAR_COLOR_CLASSES, STAR_COLORS } from '@/modules/sidebar/utils/starColors';

type StarColorPaletteProps = {
  /** Viewport point the palette opens at (the right-click or long-press). */
  anchor: { x: number; y: number };
  current: StarColor | null;
  onPick: (color: StarColor | null) => void;
  onClose: () => void;
  t: TFunction;
};

const PALETTE_WIDTH = 236;
const PALETTE_HEIGHT = 48;

/**
 * Opened from a project's star by right-click (desktop) or long-press (touch),
 * to jump straight to a color instead of cycling through them.
 */
export default function StarColorPalette({ anchor, current, onPick, onClose, t }: StarColorPaletteProps) {
  const paletteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!paletteRef.current?.contains(event.target as Node)) {
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

  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - PALETTE_WIDTH - 8));
  const top = Math.max(8, Math.min(anchor.y + 8, window.innerHeight - PALETTE_HEIGHT - 8));

  const pick = (color: StarColor | null) => {
    onPick(color);
    onClose();
  };

  return createPortal(
    <div
      ref={paletteRef}
      role="menu"
      aria-label={t('starColors.title')}
      data-testid="star-color-palette"
      className="fixed z-[100] flex items-center gap-1 rounded-lg border border-border bg-popover p-1.5 shadow-xl"
      style={{ left, top }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {STAR_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="menuitemradio"
          aria-checked={current === color}
          aria-label={t(`starColors.${color}`)}
          title={t(`starColors.${color}`)}
          data-star-color={color}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent',
            current === color && 'bg-accent ring-1 ring-border',
          )}
          onClick={() => pick(color)}
        >
          <Star className={cn('h-4 w-4 fill-current', STAR_COLOR_CLASSES[color].icon)} />
        </button>
      ))}
      <div className="mx-0.5 h-6 w-px bg-border" />
      <button
        type="button"
        role="menuitemradio"
        aria-checked={current === null}
        aria-label={t('starColors.none')}
        title={t('starColors.none')}
        data-star-color="none"
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent',
          current === null && 'bg-accent ring-1 ring-border',
        )}
        onClick={() => pick(null)}
      >
        <StarOff className="h-4 w-4" />
      </button>
    </div>,
    document.body,
  );
}
