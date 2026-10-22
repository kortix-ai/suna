/**
 * Shared handoff between a `ConnectorConnectRow` (anywhere in the transcript,
 * any turn) and the ONE `ConnectorAuthSheet` instance `SessionPage` mounts —
 * the same "one shared sheet, many entry points" shape `ConnectProviderSheet`
 * uses for model providers (COR-125/COR-158 Task 9). A row calls
 * `requestConnect`; `SessionPage` opens the sheet with that row's connector
 * info, so two overlays never stack (`useHandoffDismiss`).
 *
 * `projectId` rides along on the same context because no tool renderer
 * otherwise has it — `ToolProps` carries `sessionId`, not `projectId`, and
 * `SessionPage` holds `projectId` as a prop, not a route param a descendant
 * can read.
 */
import { createContext } from 'react';

export interface ConnectorHandoffRequest {
  projectId: string;
  slug: string;
  label: string;
  /** The project a connect link names, for the sheet's title. */
  projectName?: string | null;
  logoUri?: string | null;
  /** The tool's own `connect_url` — a `/connect/<token>` public page, opened
   *  only when the project-scoped Pipedream connect can't start. */
  fallbackConnectUrl: string;
  /**
   * Called after a connect attempt with whether the app is connected now. A
   * browser that closes without the redirect cannot say whether THIS attempt
   * landed, so an app that already had an account answers true either way.
   */
  onSettled?: (connected: boolean) => void;
}

export interface ConnectorHandoffApi {
  projectId: string | null;
  requestConnect: (request: ConnectorHandoffRequest) => void;
}

export const ConnectorHandoffContext = createContext<ConnectorHandoffApi | null>(null);
