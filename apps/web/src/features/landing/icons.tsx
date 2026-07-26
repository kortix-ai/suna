/**
 * Thin line icons for the landing sections.
 *
 * Hand-drawn on a 24px grid rather than pulled from an icon set so the whole
 * page shares one stroke weight and optical size — the reference pages get a
 * lot of their calm from exactly this.
 */

type IconProps = { className?: string };

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** A target — say what, not how. */
function GoalIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A machine / sandbox. */
function MachineIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="2.5" y="4.5" width="19" height="12" rx="1.5" />
      <path d="M8 20h8M12 16.5V20" />
      <path d="M6.5 8.5l2 2-2 2" />
      <path d="M11 12.5h4" />
    </svg>
  );
}

/** An eye — watch every step. */
function WatchIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

/** Parallel tracks — many agents at once. */
function ParallelIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M12 3v4.5M12 7.5c0 2.5-5 2-5 5v3M12 7.5c0 2.5 5 2 5 5v3" />
      <circle cx="12" cy="3" r="1.5" />
      <circle cx="7" cy="18" r="1.5" />
      <circle cx="12" cy="18" r="1.5" />
      <circle cx="17" cy="18" r="1.5" />
      <path d="M12 7.5v9" />
    </svg>
  );
}

/** A clock — runs without you. */
function ScheduleIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.25 2" />
    </svg>
  );
}

/** A merge — work lands as a change request. */
function MergeIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <circle cx="7" cy="5" r="2" />
      <circle cx="7" cy="19" r="2" />
      <circle cx="17" cy="12" r="2" />
      <path d="M7 7v10" />
      <path d="M9 5.6c4 .6 5.7 2.6 6 6.4" />
    </svg>
  );
}

/** Angle brackets — read the source. */
function SourceIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M8.5 8.5 4.5 12l4 3.5M15.5 8.5l4 3.5-4 3.5M13.5 5.5l-3 13" />
    </svg>
  );
}

/** Stacked layers — bring your own model. */
function ModelIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="m12 3.5 8.5 4.25L12 12 3.5 7.75 12 3.5Z" />
      <path d="m3.5 12 8.5 4.25L20.5 12" />
      <path d="m3.5 16.25 8.5 4.25 8.5-4.25" />
    </svg>
  );
}

/** A server — run it yourself. */
function HostIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="6.5" rx="1.5" />
      <rect x="3" y="13.5" width="18" height="6.5" rx="1.5" />
      <path d="M6.75 7.25h.01M6.75 16.75h.01" />
    </svg>
  );
}

/** An open padlock — leave whenever you want. */
function OwnIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="1.75" />
      <path d="M8.5 10.5V7.25a3.5 3.5 0 0 1 6.85-1" />
      <path d="M12 14.25v2.5" />
    </svg>
  );
}

export const landingIcons = {
  goal: GoalIcon,
  machine: MachineIcon,
  watch: WatchIcon,
  parallel: ParallelIcon,
  schedule: ScheduleIcon,
  merge: MergeIcon,
  source: SourceIcon,
  model: ModelIcon,
  host: HostIcon,
  own: OwnIcon,
} as const;

export type LandingIconName = keyof typeof landingIcons;
