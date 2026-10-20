/** Three stacked pages: the empty-folder artwork in the drive explorer. */
export function DriveEmptyArt() {
  return (
    <svg width="72" height="60" viewBox="0 0 72 60" fill="none" aria-hidden="true">
      <rect
        x="10"
        y="10"
        width="34"
        height="42"
        rx="5"
        transform="rotate(-8 10 10)"
        className="fill-card stroke-foreground/10"
      />
      <rect
        x="30"
        y="6"
        width="34"
        height="42"
        rx="5"
        transform="rotate(7 30 6)"
        className="fill-card stroke-foreground/10"
      />
      <path
        d="M22 12h17l9 9v30a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4Z"
        className="fill-muted stroke-foreground/20"
      />
      <path d="M39 12v6a3 3 0 0 0 3 3h6" className="stroke-foreground/20" />
      <path
        d="M25 30h16M25 36h16M25 42h10"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="stroke-foreground/15"
      />
    </svg>
  );
}
