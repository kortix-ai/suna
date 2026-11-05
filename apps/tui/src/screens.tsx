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
import { copyToClipboard } from './lib/clipboard.ts';
import { theme } from './theme.ts';
import type { ToastKind } from './ui/index.ts';
import { NO_WORKSPACE_TEXT, PICK_WORKSPACE_TEXT } from './lib/workspaces.ts';

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
          reveal={props.target ?? null}
          focused={focused}
          width={width}
          height={height}
          onBack={onBack}
          onToast={onToast}
        />
      );
    case 'review':
      if (!projectId) return <Missing text={PICK_WORKSPACE_TEXT} />;
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
    case 'providers':
      return (
        <ProvidersScreen
          projectId={projectId}
          accountId={accountId}
          focused={focused}
          width={width}
          height={height}
          initialProviderId={props.target ?? undefined}
          onHoldsBack={props.onHoldsBack}
          onBack={onBack}
          onToast={onToast}
        />
      );
    case 'connectors':
      return (
        <ConnectorsScreen
          projectId={projectId}
          accountId={accountId}
          focused={focused}
          width={width}
          height={height}
          webBaseUrl={props.webBaseUrl}
          initialQuery={props.target ?? undefined}
          onHoldsBack={props.onHoldsBack}
          onBack={onBack}
          onToast={onToast}
        />
      );
    case 'connect':
      return (
        <ConnectScreen
          projectId={projectId}
          focused={focused}
          width={width}
          query={props.target ?? undefined}
          onOpen={(screen, target) => props.onOpenScreen?.(screen, target)}
        />
      );
    case 'account':
      if (!accountId)
        return <Missing text={NO_WORKSPACE_TEXT} />;
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
