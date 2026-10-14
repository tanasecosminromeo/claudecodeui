import { cn } from '@/shared/utils';

/**
 * The orange dot that marks a session or project waiting on the user. It pulses
 * (the same amber as the Needs input pill), and stays still under
 * prefers-reduced-motion. Pass `label` when the dot is the only thing saying
 * so; without it the dot is decoration and hidden from assistive tech.
 */
export default function NeedsInputDot({ label, className }: { label?: string; className?: string }) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'inline-block h-2 w-2 flex-shrink-0 rounded-full bg-amber-500 motion-safe:animate-needs-input-pulse',
        className,
      )}
    />
  );
}
