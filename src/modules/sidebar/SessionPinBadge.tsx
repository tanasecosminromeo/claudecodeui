import { Pin } from 'lucide-react';

/**
 * Marks a pinned session on its provider logo. Absolutely positioned over the
 * logo's top-right corner so the row keeps its height; the ring separates it
 * from the logo and the row background behind it.
 */
export default function SessionPinBadge() {
  return (
    <span
      role="img"
      title="Pinned"
      aria-label="Pinned"
      className="pointer-events-none absolute -right-1 -top-1 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-primary ring-2 ring-card"
    >
      <Pin className="h-[7px] w-[7px] text-white" aria-hidden="true" />
    </span>
  );
}
