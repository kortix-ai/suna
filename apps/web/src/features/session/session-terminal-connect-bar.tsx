'use client';

import Hint from '@/components/ui/hint';
import { Copy } from '@/features/icon/icons/copy';
import { useTranslations } from '@/i18n/use-translations';
import { useDeploymentCliInstallCommand } from '@/lib/use-deployment-cli-install-command';
import { cn } from '@/lib/utils';
import { CaretDownIcon, CheckIcon, LaptopIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * A single quiet row at the top of the session Terminal panel. It answers
 * "how do I get a shell into this from my machine?" right where a shell lives.
 *
 * Collapsed, it is a label and nothing else. Expanded, it lists the two
 * commands as plain lines: no wells, no borders, no fills. It is app chrome,
 * so it paints Kortix tokens; only the shell itself uses the terminal palette.
 */
export function SessionTerminalConnectBar({ projectSessionId }: { projectSessionId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [expanded, setExpanded] = useState(false);
  const stepsId = useId();

  return (
    <div className="bg-background shrink-0 border-b">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-controls={stepsId}
        className="text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:ring-ring flex h-9 w-full cursor-pointer items-center gap-2 px-3 text-xs transition-colors duration-(--duration-fast) outline-none focus-visible:ring-1 focus-visible:ring-inset"
      >
        <LaptopIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          {tI18nComplete.raw('textb85e0ede430b')}
        </span>
        <CaretDownIcon
          className={cn(
            'size-3 shrink-0 motion-safe:transition-transform motion-safe:duration-(--duration-fast)',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded ? (
        <SessionTerminalConnectSteps id={stepsId} projectSessionId={projectSessionId} />
      ) : null}
    </div>
  );
}

export function SessionTerminalConnectSteps({
  id,
  projectSessionId,
}: {
  id: string;
  projectSessionId: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const installCmd = useDeploymentCliInstallCommand(undefined);
  const connectCmd = `kortix sessions connect ${projectSessionId}`;

  return (
    <ol id={id} className="space-y-3 pr-1.5 pb-3 pl-3">
      <CommandStep label={tI18nComplete.raw('textd236e9cd730b')} command={installCmd} />
      <CommandStep label={tI18nComplete.raw('text842bad27af42')} command={connectCmd} />
    </ol>
  );
}

function CommandStep({ label, command }: { label: string; command: string }) {
  return (
    <li>
      <p className="text-muted-foreground text-xs">{label}</p>
      <div className="flex h-7 items-center gap-2">
        <span aria-hidden className="text-muted-foreground font-mono text-xs select-none">
          $
        </span>
        <code
          title={command}
          className="text-foreground min-w-0 flex-1 truncate font-mono text-xs select-all"
        >
          {command}
        </code>
        <CommandCopyButton command={command} />
      </div>
    </li>
  );
}

function CommandCopyButton({ command }: { command: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const reduceMotion = useReducedMotion();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    // The check answers the click, not the clipboard promise: `writeText` can
    // take hundreds of ms to settle, and a late check reads as a missed click.
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      if (timer.current) clearTimeout(timer.current);
      setCopied(false);
    }
  }, [command]);

  // The house icon-swap morph and glyphs (see CopyButton). Reduced motion keeps
  // the cross-fade and drops the scale and blur.
  const hiddenIcon = reduceMotion
    ? { opacity: 0 }
    : { scale: 0.25, opacity: 0, filter: 'blur(4px)' };
  const shownIcon = reduceMotion ? { opacity: 1 } : { scale: 1, opacity: 1, filter: 'blur(0px)' };
  const copyLabel = tI18nComplete.raw('text9a01feecae67');

  return (
    <Hint label={copyLabel} side="top">
      <button
        type="button"
        onClick={copy}
        aria-label={copyLabel}
        className={cn(
          'focus-visible:ring-ring hit-area-1.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm transition-colors duration-(--duration-fast) outline-none focus-visible:ring-1 active:scale-[0.96]',
          copied ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <span className="relative inline-flex size-4 items-center justify-center">
          <AnimatePresence initial={false} mode="popLayout">
            <m.span
              key={copied ? 'check' : 'copy'}
              initial={hiddenIcon}
              animate={shownIcon}
              exit={hiddenIcon}
              transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
              className="absolute inset-0 inline-flex items-center justify-center"
            >
              {copied ? <CheckIcon className="size-3.5" /> : <Copy className="size-3.5" />}
            </m.span>
          </AnimatePresence>
        </span>
        <span className="sr-only" aria-live="polite">
          {copied ? tI18nComplete.raw('text8d525e5f158b') : ''}
        </span>
      </button>
    </Hint>
  );
}
