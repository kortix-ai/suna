/**
 * The secondary screens: what `/files`, `/review`, `/drive` and the rest open
 * over the session. Each one owns its own keys while it has focus, and Esc
 * brings the session back.
 *
 * One table (`SCREEN_TITLE`) names them for the panel header; `Screen` mounts
 * the one the route names. Adding a screen is a row in `Route`
 * (`app-keys.ts`), a row in the command table (`commands/registry.ts`), a row
 * here, and a branch in `Screen`.
 */

import type { ComponentType } from 'react';

import type { Route } from './app-keys.ts';
import { AccountScreen } from './features/account/index.ts';
import { AppsScreen } from './features/apps/index.ts';
import { ApprovalsScreen } from './features/approvals/index.ts';
import { ArtifactsScreen } from './features/artifacts/index.ts';
import { AuditScreen } from './features/audit/index.ts';
import { CustomizeScreen } from './features/customize/index.ts';
import { DriveScreen } from './features/drive/index.ts';
import { FilesScreen } from './features/files/index.ts';
import { GoalsScreen } from './features/goals/index.ts';
import { InboxScreen } from './features/inbox/index.ts';
import { LoopsScreen } from './features/loops/index.ts';
import { MemoryScreen } from './features/memory/index.ts';
import { RepoScreen } from './features/repo/index.ts';
import { ReviewScreen } from './features/review/index.ts';
import { RoomsScreen } from './features/rooms/index.ts';
import { SpacesScreen } from './features/spaces/index.ts';
import { copyToClipboard } from './lib/clipboard.ts';
import { theme } from './theme.ts';
import type { ToastKind } from './ui/index.ts';

export type ScreenRoute = Exclude<Route, 'session'>;

/** The panel title each screen shows. */
export const SCREEN_TITLE: Record<ScreenRoute, string> = {
  files: 'Session files',
  review: 'Change requests',
  apps: 'Apps',
  customize: 'Customize',
  account: 'Account',
  drive: 'Drive',
  repo: 'Repository',
  artifacts: 'Artifacts',
  inbox: 'Inbox',
  approvals: 'Approvals',
  goals: 'Goals',
  memory: 'Company memory',
  spaces: 'Channels and DMs',
  rooms: 'Rooms',
  loops: 'Loops',
  audit: 'Session audit',
};

export function isScreenRoute(name: string): name is ScreenRoute {
  return name in SCREEN_TITLE;
}

export interface ScreenProps {
  route: ScreenRoute;
  projectId: string | null;
  accountId: string | null;
  sessionId: string | null;
  focused: boolean;
  width: number;
  height: number;
  /** The Kortix web origin, for screens that print a link the TUI cannot open. */
  webBaseUrl: string;
  onBack(): void;
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: ToastKind): void;
}

/**
 * The screens built on the one contract (`ScreenProps` minus `route`). They
 * mount by table; the older screens above each take their own props.
 */
type ContractScreenProps = Omit<ScreenProps, 'route'>;
const CONTRACT_SCREENS = {
  drive: DriveScreen,
  repo: RepoScreen,
  artifacts: ArtifactsScreen,
  inbox: InboxScreen,
  approvals: ApprovalsScreen,
  goals: GoalsScreen,
  memory: MemoryScreen,
  spaces: SpacesScreen,
  rooms: RoomsScreen,
  loops: LoopsScreen,
  audit: AuditScreen,
} satisfies Record<string, ComponentType<ContractScreenProps>>;

type ContractRoute = keyof typeof CONTRACT_SCREENS;

function isContractRoute(route: ScreenRoute): route is ContractRoute {
  return route in CONTRACT_SCREENS;
}

/** `y` in a screen: copy, or throw so the screen shows "Copy failed". */
async function copy(text: string): Promise<void> {
  const result = await copyToClipboard(text);
  if (!result.ok) throw new Error(result.error ?? 'no clipboard tool');
}

export function Screen(props: ScreenProps) {
  const { route, projectId, accountId, sessionId, focused, width, height, onBack, onToast } = props;
  if (isContractRoute(route)) {
    const Contract = CONTRACT_SCREENS[route];
    const { route: _route, ...rest } = props;
    return <Contract {...rest} />;
  }
  switch (route) {
    case 'files':
      if (!projectId || !sessionId) return <Missing text="Open a session to browse its files." />;
      return (
        <FilesScreen
          projectId={projectId}
          sessionId={sessionId}
          focused={focused}
          width={width}
          height={height}
          onBack={onBack}
          onToast={onToast}
        />
      );
    case 'review':
      if (!projectId) return <Missing text="No project selected. Type /projects to pick one." />;
      return (
        <ReviewScreen
          projectId={projectId}
          focused={focused}
          width={width}
          height={height}
          onBack={onBack}
          onOpenSession={props.onOpenSession}
          onToast={onToast}
        />
      );
    case 'apps':
      return (
        <AppsScreen
          projectId={projectId}
          accountId={accountId}
          focused={focused}
          width={width}
          height={height}
          onBack={onBack}
          onToast={onToast}
          onCopy={copy}
        />
      );
    case 'customize':
      return (
        <CustomizeScreen
          projectId={projectId}
          accountId={accountId}
          focused={focused}
          width={width}
          height={height}
          webBaseUrl={props.webBaseUrl}
          onBack={onBack}
          onToast={onToast}
        />
      );
    case 'account':
      if (!accountId) return <Missing text="No account on this host. Type /accounts to pick one." />;
      return (
        <AccountScreen
          accountId={accountId}
          focused={focused}
          width={width}
          height={height}
          onBack={onBack}
          onToast={onToast}
        />
      );
  }
}

function Missing({ text }: { text: string }) {
  return <text fg={theme.faint}>{text}</text>;
}
