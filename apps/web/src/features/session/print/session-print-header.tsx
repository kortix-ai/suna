'use client';

/**
 * The masthead of a printed conversation.
 *
 * A PDF of a session is read away from the app — attached to a ticket, mailed
 * to a customer, filed as a record — so it has to say what it is on its own
 * face. On screen this renders nothing (`print.css` keeps `[data-print-header]`
 * display:none until the print media query), and it is in the DOM at all times
 * so that printing needs no re-render: `window.print()` is synchronous, and a
 * React commit scheduled beside it is not guaranteed to land first.
 */

export interface SessionPrintHeaderProps {
  title: string;
  projectName?: string | null;
  agentName?: string | null;
  /** Injected in tests; defaults to the moment of render. */
  now?: Date;
}

/** `16 September 2026 at 20:41` — unambiguous across locales, no slashes. */
export function formatPrintedAt(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** The meta line under the title: the parts that exist, separated by a middot. */
export function printHeaderMeta(input: {
  projectName?: string | null;
  agentName?: string | null;
  printedAt: string;
}): string {
  return [input.projectName, input.agentName, input.printedAt]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(' · ');
}

export function SessionPrintHeader({
  title,
  projectName,
  agentName,
  now,
}: SessionPrintHeaderProps) {
  const meta = printHeaderMeta({
    projectName,
    agentName,
    printedAt: formatPrintedAt(now ?? new Date()),
  });

  return (
    // `data-print-keep` survives the sibling-hiding rule in print.css — this
    // block is not on the transcript's ancestor chain, so without it the very
    // header that names the document would be the first thing removed.
    <header data-print-header data-print-keep>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      <p className="mt-1.5 text-xs text-muted-foreground">{meta}</p>
    </header>
  );
}
