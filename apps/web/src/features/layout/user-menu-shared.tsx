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

import Loading from '@/components/ui/loading';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { openExternalRoute } from '@/lib/desktop';
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
  Sun,
} from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import * as React from 'react';
import { useState } from 'react';

/**
 * Every row here is somewhere you READ — help, docs, blog, contact, support,
 * the legal pages. That is why the renderer below has one branch and opens a
 * new tab unconditionally: losing your workspace to go read something is the
 * wrong trade, and there is no row left that you go and *act* in.
 *
 * (There was one. Marketplace navigated in place, and carried an `internal`
 * flag to say so. It went with the skills marketplace, and the flag with it —
 * a one-producer field is not worth keeping warm for a hypothetical second.)
 */
export type MenuLink = {
  label: string;
  href: string;
  Icon: React.ComponentType<{ className?: string }>;
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
 * Rows render a real `<a target="_blank">` rather than calling `window.open`
 * from a handler. Three reasons: the browser opens the tab inside the click's
 * own user-gesture window, so no popup blocker can eat it — a deferred close is
 * exactly the kind of gap that trips one; cmd-click and middle-click keep
 * working; and it is a link, so it reads as one to a screen reader.
 *
 * In the desktop shell `openExternalRoute` fires first and returns true — it
 * hands the URL to the system browser — so the anchor's own navigation is
 * cancelled to avoid opening the page twice.
 */
export function HelpSubmenu({ onClose }: { onClose: () => void }) {
  const renderMenuLink = ({ label, href, Icon }: MenuLink) => (
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const openConfirm = () => deferAfterClose(() => setConfirmOpen(true));

  // `/auth` cannot be an anchor here: the navigation must run AFTER the session
  // is actually gone, and an anchor would leave on the click instead. It is not
  // a `router.push` either — `performSignOut` ends on a DOCUMENT load, which is
  // the only thing that discards the App Router caches across an identity
  // change. There is nothing to prefetch: a document load does not read the
  // segment cache.
  //
  // `preventDefault` keeps the dialog UP. Radix closes it on click, which used
  // to leave the user staring at the unchanged app for as long as the sign-out
  // took — up to the full step budget on a broken network — with nothing on
  // screen saying anything was happening. The predictable response is a second
  // click. `performSignOut` refuses re-entry, but the dialog is the honest
  // place to say so. The document load is what actually closes this.
  const performLogout = (event: React.MouseEvent) => {
    event.preventDefault();
    setPending(true);
    void performSignOut();
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
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={performLogout}>
            {pending ? <Loading className="size-4 shrink-0" /> : null}
            {pending ? 'Signing out' : 'Log out'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { openConfirm, dialog };
}
