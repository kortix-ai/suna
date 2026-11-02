import { cn } from '@kortix/ui';
import Image from 'next/image';
import type { ReactNode } from 'react';

/*
 * The frames the surface pages draw: a terminal at real text size, and the
 * frames that hold real screenshots of the desktop and phone apps. Hairlines,
 * never shadows. Every frame is drawn in tokens, so it follows the visitor's
 * theme.
 */

/** Neutral window dots. Not the macOS colours: the page spends no decorative colour. */
export function WindowDots() {
  return (
    <span aria-hidden className="flex gap-1.5">
      <span className="bg-border size-2.5 rounded-full" />
      <span className="bg-border size-2.5 rounded-full" />
      <span className="bg-border size-2.5 rounded-full" />
    </span>
  );
}

export type TerminalLine =
  | { kind: 'cmd'; text: string }
  | { kind: 'out'; text: string }
  /** A table row: never wraps; the terminal scrolls sideways instead. */
  | { kind: 'row'; text: string }
  | { kind: 'ok'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'gap' };

/**
 * A terminal: commands after a muted prompt, output under them, `#` notes
 * muted. Long lines wrap as a real terminal does, so nothing is cut at 390 px.
 */
export function TerminalFrame({
  title,
  lines,
  size = 'lg',
}: {
  title: string;
  lines: readonly TerminalLine[];
  size?: 'lg' | 'sm';
}) {
  return (
    <div className="bg-background w-full overflow-hidden rounded-lg border">
      <div className="flex items-center gap-4 border-b px-4 py-2.5">
        <WindowDots />
        <span className="text-muted-foreground flex-1 truncate text-center font-mono text-xs">{title}</span>
        <span aria-hidden className="w-12" />
      </div>
      <pre
        className={cn(
          'overflow-x-auto font-mono break-words whitespace-pre-wrap',
          size === 'lg' ? 'px-4 py-5 text-xs leading-6 sm:px-6 sm:text-sm sm:leading-7' : 'px-4 py-4 text-xs leading-6',
        )}
      >
        {lines.map((line, i) =>
          line.kind === 'gap' ? (
            <span key={i} className="block h-3" />
          ) : (
            <span
              key={i}
              className={cn(
                'block',
                (line.kind === 'cmd' || line.kind === 'ok') && 'text-foreground',
                line.kind === 'out' && 'text-muted-foreground pl-4',
                line.kind === 'row' && 'text-muted-foreground w-max pl-4 whitespace-pre',
                line.kind === 'ok' && 'pl-4',
                line.kind === 'note' && 'text-muted-foreground',
              )}
            >
              {line.kind === 'cmd' ? <span className="text-muted-foreground select-none">$ </span> : null}
              {line.kind === 'ok' ? <span className="text-kortix-green select-none">✓ </span> : null}
              {line.kind === 'note' ? <span className="select-none"># </span> : null}
              {line.text}
            </span>
          ),
        )}
      </pre>
    </div>
  );
}

/**
 * A real screenshot in the visitor's theme: `<src>-light.webp` under the light
 * theme, `<src>-dark.webp` under `.dark`. Both were shot from the same synthetic
 * Arcadia project on dev, toggling the app's own theme between passes.
 */
function ThemedShot({ src, alt, width, height, sizes }: { src: string; alt: string; width: number; height: number; sizes: string }) {
  return (
    <>
      <Image src={`${src}-light.webp`} alt={alt} width={width} height={height} sizes={sizes} className="block h-auto w-full dark:hidden" />
      <Image src={`${src}-dark.webp`} alt={alt} width={width} height={height} sizes={sizes} className="hidden h-auto w-full dark:block" />
    </>
  );
}

const PHONE_SHOTS = {
  start: 'The Kortix iPhone app: a new session with a photo attached and a prompt typed in the composer.',
  permission: 'The Kortix iPhone app: a session paused on a permission request to run git push, with Deny, Allow once and Always allow.',
  review: 'The Kortix iPhone app: change request #2, its details, what changed, and the Request changes and Merge buttons.',
  notify: 'The Kortix iPhone app: notification settings with switches for task completions, errors, questions and permission requests.',
} as const;

/** One iOS Simulator screenshot of the shipped app (1206x2622, stored at 603x1311) in a phone body. */
export function PhoneShot({ name }: { name: keyof typeof PHONE_SHOTS }) {
  return (
    <div /* audit:allow device art: a phone body, no UI radius token draws one */ className="bg-background border-border mx-auto w-72 max-w-full overflow-hidden rounded-[2.75rem] border p-2">
      <div /* audit:allow device art: the screen, concentric with the body */ className="border-border overflow-hidden rounded-[2.25rem] border">
        <ThemedShot src={`/images/mobile-app/${name}`} alt={PHONE_SHOTS[name]} width={603} height={1311} sizes="288px" />
      </div>
    </div>
  );
}

/**
 * The desktop app: the shipped web app as the Electron shell renders it
 * (`KortixDesktop` user agent, macOS, 1440x900 at 2x). The shell leaves the
 * top-left corner to the native traffic lights; the dots stand in for them.
 */
export function DesktopShot() {
  return (
    <div className="bg-background relative w-full overflow-hidden rounded-lg border">
      <ThemedShot
        src="/images/desktop-app/session-full"
        alt="The Kortix desktop app on macOS: the Arcadia project's sessions, and a session that fixed a billing bug, proved it with tests and opened a change request."
        width={2304}
        height={1440}
        sizes="(min-width: 1280px) 1152px, 100vw"
      />
      <span /* audit:allow device art: the traffic lights sit at a fixed spot in the shell's title bar */ className="absolute top-[2.2%] left-[1.4%]">
        <WindowDots />
      </span>
    </div>
  );
}
