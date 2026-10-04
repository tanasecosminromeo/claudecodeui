import type { Project, StarColor } from '@/shared/types';

/** Click-to-cycle order, which is also the sort rank. Mirrors the server's list. */
export const STAR_COLORS: readonly StarColor[] = ['yellow', 'orange', 'red', 'green', 'blue', 'purple'];

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
  green: {
    icon: 'text-green-600 dark:text-green-400',
    swatch: 'bg-green-500',
    row: 'bg-green-50/50 dark:bg-green-900/10 hover:bg-green-100/50 dark:hover:bg-green-900/20',
    card: 'bg-green-50/50 dark:bg-green-900/5 border-green-200/30 dark:border-green-800/30',
    button: 'bg-green-500/10 dark:bg-green-900/30 border-green-200 dark:border-green-800',
  },
  blue: {
    icon: 'text-blue-500 dark:text-blue-400',
    swatch: 'bg-blue-500',
    row: 'bg-blue-50/50 dark:bg-blue-900/10 hover:bg-blue-100/50 dark:hover:bg-blue-900/20',
    card: 'bg-blue-50/50 dark:bg-blue-900/5 border-blue-200/30 dark:border-blue-800/30',
    button: 'bg-blue-500/10 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800',
  },
  purple: {
    icon: 'text-purple-500 dark:text-purple-400',
    swatch: 'bg-purple-500',
    row: 'bg-purple-50/50 dark:bg-purple-900/10 hover:bg-purple-100/50 dark:hover:bg-purple-900/20',
    card: 'bg-purple-50/50 dark:bg-purple-900/5 border-purple-200/30 dark:border-purple-800/30',
    button: 'bg-purple-500/10 dark:bg-purple-900/30 border-purple-200 dark:border-purple-800',
  },
};

export const isStarColor = (value: unknown): value is StarColor =>
  typeof value === 'string' && (STAR_COLORS as readonly string[]).includes(value);

/**
 * The project's star color. Projects starred by an older server that only
 * sends `isStarred` read as yellow.
 */
export const getStarColor = (project: Pick<Project, 'starColor' | 'isStarred'>): StarColor | null => {
  if (isStarColor(project.starColor)) {
    return project.starColor;
  }
  return project.starColor === undefined && project.isStarred ? 'yellow' : null;
};

/** Gmail-style cycle: none → yellow → … → purple → none. */
export const nextStarColor = (current: StarColor | null): StarColor | null => {
  if (current === null) {
    return STAR_COLORS[0];
  }
  const index = STAR_COLORS.indexOf(current);
  return index === STAR_COLORS.length - 1 ? null : STAR_COLORS[index + 1];
};

/** Sort rank: starred colors in list order, unstarred last. */
export const starColorRank = (color: StarColor | null): number =>
  color === null ? STAR_COLORS.length : STAR_COLORS.indexOf(color);
