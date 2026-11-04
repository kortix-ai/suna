'use client';

import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import { Copy } from '@kortix/ui/icons';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

const COPIED_MS = 1500;

/**
 * One contact channel as a hairline row: the label on the left, the address
 * on the right (after Lexington astromaxsp `contact/channels`). The whole row
 * is one button that copies `copy` (the address, or a link's URL). The copy
 * icon is hidden until the row is hovered or focused; then the address takes
 * the ring colour and the icon fades in. After a copy the icon is a ring
 * check for 1.5s and a polite live region says so. The icon slot keeps its
 * width when hidden, so the address never moves.
 */
export function CopyRow({
  label,
  value,
  copy = value,
  copiedLabel = 'Copied',
}: {
  label: ReactNode;
  value: string;
  /** What lands on the clipboard. Defaults to `value`. */
  copy?: string;
  copiedLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(copy);
    } catch {
      return; // No clipboard permission: nothing was copied, so claim nothing.
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={`${typeof label === 'string' ? `${label}: ` : ''}${value}. Copy`}
      className="group outline-ring flex w-full items-center justify-between gap-6 py-5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 lg:py-6"
    >
      <span className="text-muted-foreground shrink-0 text-sm">{label}</span>
      <span className="flex min-w-0 items-center gap-3">
        <span className="text-foreground group-hover:text-ring group-focus-visible:text-ring truncate text-base transition-colors duration-normal ease-out lg:text-lg">
          {value}
        </span>
        <span
          aria-hidden
          className="text-muted-foreground flex size-4 shrink-0 items-center justify-center opacity-0 transition-opacity duration-normal ease-out group-hover:opacity-100 group-focus-visible:opacity-100 data-[copied=true]:opacity-100"
          data-copied={copied}
        >
          {copied ? <SolidCheckIcon className="text-ring size-4" /> : <Copy className="size-4" />}
        </span>
      </span>
      <span className="sr-only" aria-live="polite">
        {copied ? copiedLabel : ''}
      </span>
    </button>
  );
}

/**
 * A channel that opens instead of copying (Discord, X, LinkedIn): the copy
 * row's shape, label left and destination right, opening in a new tab. On
 * hover the destination takes the ring colour and an up-right arrow fades in
 * where the copy icon would be.
 */
export function LinkRow({ label, value, href }: { label: ReactNode; value: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group outline-ring flex w-full items-center justify-between gap-6 py-5 focus-visible:outline-2 focus-visible:-outline-offset-2 lg:py-6"
    >
      <span className="text-muted-foreground shrink-0 text-sm">{label}</span>
      <span className="flex min-w-0 items-center gap-3">
        <span className="text-foreground group-hover:text-ring group-focus-visible:text-ring truncate text-base transition-colors duration-normal ease-out lg:text-lg">
          {value}
        </span>
        <ArrowUpRightIcon
          aria-hidden
          className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity duration-normal ease-out group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </span>
    </a>
  );
}
