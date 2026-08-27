'use client';

/**
 * The rows two different menus both need: Theme, Help, and the log-out flow.
 *
 * There are two account-ish menus in the product now — `UserMenu` in the app
 * header, and `WorkspaceSwitcher` in the project sidebar — and they are NOT the
 * same menu. The header one is about the person (account settings, billing, user
 * settings); the sidebar one is about the workspace, and only carries the handful
 * of account rows that have nowhere else to live. What they share is exactly
 * what is in this file. Extracted rather than copied so a change to the theme
 * options or the help links cannot land in one menu and miss the other.
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';

import { openExternalRoute } from '@/lib/desktop';
import { createClient } from '@/lib/supabase/client';
import { resetClientState } from '@/lib/utils/reset-client-state';
import {
  ArticleIcon,
  BookOpenIcon,
  HeadsetIcon,
  LifebuoyIcon,
  MonitorIcon,
  Moon,
  PaperPlaneTiltIcon,
  QuestionIcon,
  ScrollIcon,
  ShieldCheckIcon,
  StorefrontIcon,
  Sun,
} from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useEffect, useState } from 'react';

export type MenuLink = {
  label: string;
  href: string;
  Icon: React.ComponentType<{ className?: string }>;
  /**
   * Navigate in place instead of opening a new tab. Only Marketplace: it is
   * somewhere you go and act — browse, install — so it belongs in the session
   * you are already in. Everything else under Help is something you read, and
   * losing your workspace to go read it is the wrong trade.
   */
  internal?: boolean;
};

/**
 * Reference destinations, grouped under Help.
 *
 * Hoisted to module scope so the arrays and their objects are allocated once for
 * the app instead of being rebuilt on every render — these menus mount in both
 * the sidebar and the header, so this render path is not rare.
 */
export const HELP_LINKS: MenuLink[] = [
  { label: 'Help center', href: '/help', Icon: LifebuoyIcon },
  { label: 'Docs', href: '/docs', Icon: BookOpenIcon },
  { label: 'Blog', href: '/blog', Icon: ArticleIcon },
  { label: 'Marketplace', href: '/marketplace', Icon: StorefrontIcon, internal: true },
  { label: 'Contact', href: '/contact', Icon: PaperPlaneTiltIcon },
  { label: 'Support', href: '/support', Icon: HeadsetIcon },
];

/** Kept separate so a divider can hold the legal pages apart from the rest. */
export const LEGAL_LINKS: MenuLink[] = [
  { label: 'Privacy', href: '/legal?tab=privacy', Icon: ShieldCheckIcon },
  { label: 'Terms and conditions', href: '/legal/terms', Icon: ScrollIcon },
];

/**
 * The three theme values `next-themes` accepts, in the order the rest of the
 * product lists them (see the Appearance tab in user settings — same words, same
 * icons, same order). A person who learns the control in one place should not
 * have to re-read it in the other.
 */
export const THEME_OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
] as const;

/**
 * Theme as a submenu of three rows like any other.
 *
 * It used to be a segmented control pinned below Log out — the one row in the
 * menu that was not a menu item, sitting under the one row that ends your
 * session. The leading icon shows the theme currently IN EFFECT, not the value
 * stored: on `system` it tracks what the OS resolved to, which is the only
 * answer to "what am I looking at right now".
 */
export function ThemeSubmenu() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {resolvedTheme === 'dark' ? <Moon /> : <Sun />}
        Appearance
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="space-y-0.5" sideOffset={6}>
          <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
            {THEME_OPTIONS.map(({ value, label, Icon }) => (
              <DropdownMenuRadioItem key={value} value={value}>
                <Icon />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

/**
 * Every reference and legal page collapsed into one submenu, so the top level
 * only carries things you act on rather than eight links.
 *
 * External rows render a real `<a target="_blank">` rather than calling
 * `window.open` from a handler. Three reasons: the browser opens the tab inside
 * the click's own user-gesture window, so no popup blocker can eat it — a
 * deferred close is exactly the kind of gap that trips one; cmd-click and
 * middle-click keep working; and it is a link, so it reads as one to a screen
 * reader.
 *
 * In the desktop shell `openExternalRoute` fires first and returns true — it
 * hands the URL to the system browser — so the anchor's own navigation is
 * cancelled to avoid opening the page twice.
 */
export function HelpSubmenu({ onClose }: { onClose: () => void }) {
  const renderMenuLink = ({ label, href, Icon, internal }: MenuLink) =>
    internal ? (
      // An anchor, exactly like the external branch below. `router.push` from a
      // menu row runs the RSC fetch cold at click time, and that fetch degrades
      // into a full document load whenever it answers wrong — a build-id skew
      // mid-deploy, a maintenance redirect, a network blip.
      <DropdownMenuItem key={href} asChild onClick={onClose}>
        <Link href={href} prefetch>
          <Icon />
          {label}
        </Link>
      </DropdownMenuItem>
    ) : (
      <DropdownMenuItem key={href} asChild>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (openExternalRoute(href)) event.preventDefault();
            onClose();
          }}
        >
          <Icon />
          {label}
        </a>
      </DropdownMenuItem>
    );

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <QuestionIcon />
        Help
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="space-y-0.5" sideOffset={6}>
          {HELP_LINKS.map(renderMenuLink)}

          <DropdownMenuSeparator />

          {LEGAL_LINKS.map(renderMenuLink)}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

/**
 * Log out, behind a confirmation.
 *
 * Returns the dialog as an element rather than rendering it inline, because it
 * MUST mount as a sibling of the dropdown, never inside its content: Radix
 * unmounts `DropdownMenuContent` on close, so a dialog living in there would be
 * torn down the instant the menu closed — which is the exact moment you click
 * "Log out".
 */
export function useLogoutFlow(deferAfterClose: (fn: () => void) => void) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const openConfirm = () => deferAfterClose(() => setConfirmOpen(true));

  // `/auth` cannot be an anchor here: the navigation must run AFTER
  // `signOut()` and `resetClientState()` resolve, and an anchor would leave on
  // the click instead. Warm the destination while the confirmation is up, so
  // the push reads the segment cache rather than running the RSC fetch cold —
  // the fetch that degrades into a full document load when it answers wrong.
  // Middleware skips identity resolution on `/auth` entirely
  // (`middleware.ts:494-500`), so prefetching it from a live session is
  // answered normally.
  useEffect(() => {
    if (confirmOpen) router.prefetch('/auth');
  }, [confirmOpen, router]);

  const performLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    await resetClientState();
    // nav-contract: prefetch-only — the navigation must follow signOut(), so it
    // stays a push; the effect above puts /auth in the cache first.
    router.push('/auth');
  };

  const dialog = (
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Log out of your account?</AlertDialogTitle>
          <AlertDialogDescription>
            You&apos;ll need to sign in again to get back to your workspaces.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={performLogout}>
            Log out
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { openConfirm, dialog };
}
