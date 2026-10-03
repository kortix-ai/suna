/**
 * ConnectorAuthSheet — the hand-off before opening the browser to connect an
 * app the agent asked for mid-chat (COR-158, connector remainder). Sibling of
 * `ConnectProviderSheet` (COR-125/COR-158 Task 9), not a generalization of it:
 * the two connect fundamentally different things (a model provider via a
 * static web URL vs. a project connector via a fresh Pipedream round trip
 * per attempt), so forcing one component to own both async shapes would have
 * meant branching its `run` callback on a "kind" flag instead of the two
 * sheets just being two thin wrappers around the same shared primitive. What
 * IS shared, and reused rather than duplicated: the visual shell
 * (`HandoffSheetBody`: Kortix · · · App, a title, one muted line, then
 * "Continue to {app}" ↗ over Not now) and the close-then-open dismiss dance
 * (`useHandoffDismiss`, `handoff-sheet.ts`).
 *
 * Continue tries the project's own Pipedream connect flow first — the
 * `pipedreamConnect`/`pipedreamFinalize` round trip
 * (`lib/projects/projects-client.ts`), which mints a URL that
 * supports a `kortix://` redirect (`WebBrowser.openAuthSessionAsync` auto-
 * dismisses on it) — and falls back to the agent's own `connect_url` (a
 * `/connect/<token>` public web page with no redirect support, so it opens
 * plain, via `openBrowserAsync`) only when that project-scoped connect can't
 * start (the connector isn't declared as a Pipedream app for this project, or
 * the request itself fails).
 *
 * One instance lives in `SessionPage`, shared by every `ConnectorConnectRow`
 * in the transcript via `ConnectorHandoffContext` — exactly like
 * `ConnectProviderSheet` is shared by every "Connect provider" entry point.
 */
import * as React from 'react';
import * as WebBrowser from 'expo-web-browser';
import { useQueryClient } from '@tanstack/react-query';
import { finalizeConnectorSetupLink } from '@kortix/sdk';

import { API_URL } from '@/api/config';

import { Sheet, type SheetRef } from '@/components/kortix/sheet';
import { useToast } from '@/components/kortix/toast-provider';
import { parseSetupLinkHref } from '@/lib/markdown/setup-links';
import { projectKeys } from '@/lib/projects/hooks';
import { listConnectors, pipedreamConnect, pipedreamFinalize } from '@/lib/projects/projects-client';
import { openBrowserUntilClosed } from '@/lib/utils/open-browser';
import {
  connectorHandoffCopy,
  connectorHandoffToast,
  isConnectorConnected,
} from '@/lib/session/connector-handoff';
import { HandoffSheetBody } from './connector-handshake';
import { useHandoffDismiss } from './handoff-sheet';
import type { ConnectorHandoffRequest } from './tool/shared/connector-handoff-context';

// App deep links so the connect browser auto-dismisses back to the app
// (`openAuthSessionAsync` returns when it sees this scheme) instead of
// stranding the user on Pipedream's web success page. `kortix://connectors`
// is a browser-return root (`isBrowserReturnPath`, `lib/session/connect-model.ts`).
const CONNECT_RETURN_URL = 'kortix://connectors';
const CONNECT_SUCCESS_URI = 'kortix://connectors/success';
const CONNECT_ERROR_URI = 'kortix://connectors/error';

interface ConnectorAuthSheetProps {
  /** The row currently asking to connect. Null between requests — the sheet
   *  stays mounted, so its body just has nothing to show until one arrives. */
  request: ConnectorHandoffRequest | null;
}

export const ConnectorAuthSheet = React.forwardRef<SheetRef, ConnectorAuthSheetProps>(
  ({ request }, ref) => {
    const toast = useToast();
    const queryClient = useQueryClient();
    const sheetRef = React.useRef<SheetRef>(null);

    const { requestContinue, handleDismiss } = useHandoffDismiss(async () => {
      if (!request) return;
      const { projectId, slug, label, fallbackConnectUrl, onSettled } = request;
      let connected = false;
      // The project's own connect returned through the `kortix://` redirect.
      let authorized = false;

      try {
        const started = await pipedreamConnect(projectId, slug, {
          successRedirectUri: CONNECT_SUCCESS_URI,
          errorRedirectUri: CONNECT_ERROR_URI,
        });
        if (started.connectUrl) {
          // `openAuthSessionAsync` auto-dismisses once Pipedream redirects to
          // our scheme.
          const result = await WebBrowser.openAuthSessionAsync(
            started.connectUrl,
            CONNECT_RETURN_URL,
          );
          authorized = result.type === 'success' && !/[?&]error=|\/error(?:$|[/?])/.test(result.url);
        } else {
          await openBrowserUntilClosed(fallbackConnectUrl);
        }
      } catch {
        // The project-scoped connect couldn't even start (connector isn't a
        // declared Pipedream app for this project, network failure, …) — the
        // agent's own link is the fallback, opened plain since it carries no
        // redirect the browser can detect.
        try {
          await openBrowserUntilClosed(fallbackConnectUrl);
        } catch {
          // The browser trip itself failed to open; the status re-check below
          // still runs, in case the connector was completed another way.
        }
      }

      // The agent's link is a setup link, and its finalize goes FIRST: it is
      // the one call that both persists the account and tells the session that
      // asked, so the agent continues on its own. It tells the session only
      // when it is the call that persists; after the project finalize below it
      // would find the credential saved and stay silent. Public and
      // idempotent. It also answers when the browser closed without the
      // `kortix://` redirect (Expo Go, a tab closed by hand).
      const setupLink = parseSetupLinkHref(fallbackConnectUrl);
      if (setupLink?.kind === 'connector') {
        const finalized = await finalizeConnectorSetupLink(setupLink.token, { backendUrl: API_URL }).catch(
          () => null,
        );
        connected = finalized?.connected ?? false;
      }
      if (!connected && authorized) {
        const finalized = await pipedreamFinalize(projectId, slug).catch(() => null);
        connected = finalized?.connected ?? false;
      }

      if (!connected) {
        try {
          const rows = await listConnectors(projectId);
          connected = isConnectorConnected(rows.connectors.find((row) => row.slug === slug));
        } catch {
          // Leave `connected` false — the row keeps offering Connect.
        }
      }

      queryClient.invalidateQueries({ queryKey: projectKeys.connectors(projectId) });
      onSettled?.(connected);
      toast[connected ? 'success' : 'error'](connectorHandoffToast(label, connected));
    });

    React.useImperativeHandle(ref, () => ({
      open: () => sheetRef.current?.open(),
      close: () => sheetRef.current?.close(),
    }));

    const handleContinue = React.useCallback(() => {
      requestContinue(sheetRef);
    }, [requestContinue]);

    // Between requests the sheet is closed; the words only keep its height.
    const copy = connectorHandoffCopy(request?.label ?? 'app', request?.projectName);

    return (
      <Sheet ref={sheetRef} enablePanDownToClose onDismiss={handleDismiss}>
        <HandoffSheetBody
          name={request?.label ?? ''}
          iconUrl={request?.logoUri ?? null}
          title={copy.title}
          body={copy.body}
          action={copy.action}
          onContinue={handleContinue}
          onClose={() => sheetRef.current?.close()}
        />
      </Sheet>
    );
  },
);
ConnectorAuthSheet.displayName = 'ConnectorAuthSheet';
