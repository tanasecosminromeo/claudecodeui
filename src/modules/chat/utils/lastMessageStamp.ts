import type { ChatMessage } from '@/shared/types';

const pad = (value: number) => String(value).padStart(2, '0');

/** Local wall-clock time as `YYYY-MM-DD HH:mm:ss`. */
export function formatFullTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Elapsed time as `2d 3h 0m 5s`, starting at the largest non-zero unit so a
 * fresh message reads `42s` and an old one keeps every smaller unit.
 */
export function formatElapsed(ms: number): string {
  let seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;

  const units: Array<[number, string]> = [[days, 'd'], [hours, 'h'], [minutes, 'm'], [seconds, 's']];
  const first = units.findIndex(([value]) => value > 0);
  return units.slice(first === -1 ? units.length - 1 : first).map(([value, unit]) => `${value}${unit}`).join(' ');
}

/** The newest message carrying a parseable timestamp, as epoch ms. */
export function lastMessageTime(messages: ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const time = new Date(messages[i].timestamp).getTime();
    if (Number.isFinite(time)) return time;
  }
  return null;
}
