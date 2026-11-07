/**
 * The secondary screens: what `/files`, `/review`, `/drive` and the rest open
 * over the session. Each one owns its own keys while it has focus, and Esc
 * brings the session back.
 *
 * One table (`SCREEN_TITLE`) names them for the panel header; another
 * (`SCREENS`) holds their components, and `Screen` mounts the one the route
 * names. Adding a screen is a row in `Route` (`app-keys.ts`), a row in the
 * command table (`commands/registry.ts`), and a row in each table here.
 */

import type { ComponentType } from 'react';

import type { Route } from './app-keys.ts';
import { AccountScreen } from './features/account/index.ts';
import { AppsScreen } from './features/apps/index.ts';
import { ApprovalsScreen } from './features/approvals/index.ts';
import { ArtifactsScreen } from './features/artifacts/index.ts';
import { AuditScreen } from './features/audit/index.ts';
import { CustomizeScreen } from './features/customize/index.ts';
import { ProvidersScreen } from './features/providers/index.ts';
import { ConnectScreen, ConnectorsScreen } from './features/connectors/index.ts';
import { DriveScreen } from './features/drive/index.ts';
import { FilesScreen } from './features/files/index.ts';
import { GoalsScreen } from './features/goals/index.ts';
import { InboxScreen } from './features/inbox/index.ts';
import { LoopsScreen } from './features/loops/index.ts';
import { MemoryScreen } from './features/memory/index.ts';
import { RepoScreen } from './features/repo/index.ts';
import { ReviewScreen } from './features/review/index.ts';
import { SpacesScreen } from './features/spaces/index.ts';
import type { ToastKind } from './ui/index.ts';

export type ScreenRoute = Exclude<Route, 'session'>;

/** The panel title each screen shows. */
export const SCREEN_TITLE: Record<ScreenRoute, string> = {
  files: 'Session files',
  review: 'Change requests',
  apps: 'Apps',
  customize: 'Customize',
  providers: 'Model providers',
  connectors: 'Connectors',
  connect: 'Connect',
  account: 'Workspace members',
  drive: 'Drive',
  repo: 'Repository',
  artifacts: 'Artifacts',
  inbox: 'Inbox',
  approvals: 'Approvals',
  goals: 'Goals',
  memory: 'Company memory',
  spaces: 'Channels and DMs',
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
  /** What the screen opens on: an artifact id (`artifacts`), a file path (`files`), a provider id (`providers`). */
  target?: string | null;
  onBack(): void;
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: ToastKind): void;
  /** The screen holds Esc (a pane to go back from, an input open). The app then leaves Esc to it. */
  onHoldsBack?(holds: boolean): void;
  /** Open another screen (`/connect` routes to `/providers` or `/connectors`). */
  onOpenScreen?(route: ScreenRoute, target: string | null): void;
}

/**
 * Every screen takes `ScreenProps` minus `route`, so `Screen` mounts each one
 * the same way.
 */
const SCREENS = {
  files: FilesScreen,
  review: ReviewScreen,
  apps: AppsScreen,
  customize: CustomizeScreen,
  providers: ProvidersScreen,
  connectors: ConnectorsScreen,
  connect: ConnectScreen,
  account: AccountScreen,
  drive: DriveScreen,
  repo: RepoScreen,
  artifacts: ArtifactsScreen,
  inbox: InboxScreen,
  approvals: ApprovalsScreen,
  goals: GoalsScreen,
  memory: MemoryScreen,
  spaces: SpacesScreen,
  loops: LoopsScreen,
  audit: AuditScreen,
} satisfies Record<ScreenRoute, ComponentType<Omit<ScreenProps, 'route'>>>;

export function Screen({ route, ...rest }: ScreenProps) {
  const Mounted = SCREENS[route];
  return <Mounted {...rest} />;
}
