import { Pin } from 'lucide-react';

/**
 * Marks a pinned session on its provider logo. Absolutely positioned over the
 * logo's top-right corner so the row keeps its height; the ring separates it
 * from the logo and the row background behind it. The pin's size is forced
 * (`!size-2`) because the desktop row is styled as a button, whose
 * `[&_svg]:size-4` would otherwise blow it up to 16 px.
 */
export default function SessionPinBadge() {
  return (
    <span
      role="img"
      title="Pinned"
      aria-label="Pinned"
      className="pointer-events-none absolute -right-1.5 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary ring-2 ring-card"
    >
      <Pin className="!size-2 fill-white text-white" strokeWidth={2.5} aria-hidden="true" />
    </span>
  );
}
