import type { Project, StarColor, StarFilter } from '@/shared/types';

/**
 * Click-to-cycle order, which is also rising priority: each click moves a star
 * up this list, and the filter chip shows a colour and everything hotter than it.
 * Mirrors the server's list.
 */
export const STAR_COLORS: readonly StarColor[] = ['green', 'yellow', 'orange', 'red'];

type StarColorClasses = {
  /** The filled star icon. */
  icon: string;
  /** The palette swatch. */
  swatch: string;
  /** Tint for a starred, unselected desktop row. */
  row: string;
  /** Tint for a starred, unselected compact (mobile) card. */
  card: string;
  /** The compact star button's background and border. */
  button: string;
};

// Spelled out in full so Tailwind's scanner sees every class.
export const STAR_COLOR_CLASSES: Record<StarColor, StarColorClasses> = {
  green: {
    icon: 'text-green-600 dark:text-green-400',
    swatch: 'bg-green-500',
    row: 'bg-green-50/50 dark:bg-green-900/10 hover:bg-green-100/50 dark:hover:bg-green-900/20',
    card: 'bg-green-50/50 dark:bg-green-900/5 border-green-200/30 dark:border-green-800/30',
    button: 'bg-green-500/10 dark:bg-green-900/30 border-green-200 dark:border-green-800',
  },
  yellow: {
    icon: 'text-yellow-500 dark:text-yellow-400',
    swatch: 'bg-yellow-400',
    row: 'bg-yellow-50/50 dark:bg-yellow-900/10 hover:bg-yellow-100/50 dark:hover:bg-yellow-900/20',
    card: 'bg-yellow-50/50 dark:bg-yellow-900/5 border-yellow-200/30 dark:border-yellow-800/30',
    button: 'bg-yellow-500/10 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800',
  },
  orange: {
    icon: 'text-orange-500 dark:text-orange-400',
    swatch: 'bg-orange-500',
    row: 'bg-orange-50/50 dark:bg-orange-900/10 hover:bg-orange-100/50 dark:hover:bg-orange-900/20',
    card: 'bg-orange-50/50 dark:bg-orange-900/5 border-orange-200/30 dark:border-orange-800/30',
    button: 'bg-orange-500/10 dark:bg-orange-900/30 border-orange-200 dark:border-orange-800',
  },
  red: {
    icon: 'text-red-500 dark:text-red-400',
    swatch: 'bg-red-500',
    row: 'bg-red-50/50 dark:bg-red-900/10 hover:bg-red-100/50 dark:hover:bg-red-900/20',
    card: 'bg-red-50/50 dark:bg-red-900/5 border-red-200/30 dark:border-red-800/30',
    button: 'bg-red-500/10 dark:bg-red-900/30 border-red-200 dark:border-red-800',
  },
};

/** Retired colours and the colour they now read as. Old data stored blue or purple reads as green. */
const RETIRED_STAR_COLORS: ReadonlyMap<string, StarColor> = new Map([
  ['blue', 'green'],
  ['purple', 'green'],
]);

export const isStarColor = (value: unknown): value is StarColor =>
  typeof value === 'string' && (STAR_COLORS as readonly string[]).includes(value);

/**
 * The project's star colour. Projects starred by an older server that only
 * sends `isStarred` read as yellow; retired blue and purple read as green.
 */
export const getStarColor = (project: Pick<Project, 'starColor' | 'isStarred'>): StarColor | null => {
  const stored: unknown = project.starColor;
  if (isStarColor(stored)) {
    return stored;
  }
  if (typeof stored === 'string') {
    return RETIRED_STAR_COLORS.get(stored) ?? null;
  }
  return stored === undefined && project.isStarred ? 'yellow' : null;
};

/** Gmail-style cycle: none → green → … → red → none. */
export const nextStarColor = (current: StarColor | null): StarColor | null => {
  if (current === null) {
    return STAR_COLORS[0];
  }
  const index = STAR_COLORS.indexOf(current);
  return index === STAR_COLORS.length - 1 ? null : STAR_COLORS[index + 1];
};

/**
 * How long after a star click another click still counts as "the same
 * gesture", so it moves to the next colour instead of starting over.
 */
export const STAR_CYCLE_WINDOW_MS = 3000;

/**
 * What one click on a project's star does. Gmail style: an unstarred project
 * becomes green; a quick second click moves up through the colours (red then
 * clears); a click after the window clears the star.
 *
 * `msSinceLastClick` is null when this project has no recorded star click.
 */
export const starAfterClick = (current: StarColor | null, msSinceLastClick: number | null): StarColor | null => {
  if (current === null) {
    return STAR_COLORS[0];
  }
  if (msSinceLastClick !== null && msSinceLastClick < STAR_CYCLE_WINDOW_MS) {
    return nextStarColor(current);
  }
  return null;
};

export type { StarFilter } from '@/shared/types';

/**
 * A threshold filter nobody can pick any more reads as `all`, so the list is
 * never stuck on a colour that is no longer offered.
 */
export const normalizeStarFilter = (filter: StarFilter, options: readonly StarColor[]): StarFilter => (
  filter !== 'off' && filter !== 'all' && !options.includes(filter) ? 'all' : filter
);

/**
 * Chip click order: off → all → each offered threshold (hotter each time) → off.
 * `options` comes from `starFilterOptions`, already in narrowing order.
 */
export const nextStarFilter = (current: StarFilter, options: readonly StarColor[]): StarFilter => {
  const normalized = normalizeStarFilter(current, options);

  if (normalized === 'off') {
    return 'all';
  }
  if (normalized === 'all') {
    return options[0] ?? 'off';
  }
  const index = options.indexOf(normalized);
  return index === options.length - 1 ? 'off' : options[index + 1];
};
