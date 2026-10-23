'use client';

import { setUiRoutes, UiProvider, type UiHostConfig, type UiNavigation } from '@kortix/ui';
import { useLumenSlashActions } from '@/components/workflows/slash-workflows';
import { defaultUiMessages, type UiI18nHost } from '@kortix/ui/i18n';
import { IconProvider } from '@kortix/ui/icon-provider';
import { TooltipProvider } from '@kortix/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { LUMEN_UI_BRAND } from '@/components/brand-mark';
import { authClient } from '@/lib/auth-client';
import { resolveLumenPreviewUrl } from '@/lib/preview-url';
import { type AuthClient, ConvexBetterAuthProvider } from '@convex-dev/better-auth/react';
import { ConvexReactClient } from 'convex/react';
// The toast host. @kortix/ui/toast draws every toast (successToast,
// errorToast, …) into the <Toaster /> it exports, so the host needs no sonner
// dependency of its own.
import { Toaster, errorToast, successToast } from '@kortix/ui/toast';
import { getActiveMatter } from '@/lib/session';
import { errorText } from '@/lib/utils';
import { VAULT_ACCEPT, refuseReason } from '@/lib/vault-files';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

// Client-side navigation for @kortix/ui (useUiRouter().push), not full page loads.
const navigation: UiNavigation = { useRouter, usePathname, useSearchParams, useParams };
// Lumen's mark wherever @kortix/ui would draw the Kortix symbol.
const useLumenBrand = () => LUMEN_UI_BRAND;

// Lumen serves two of the pages @kortix/ui links to: a project (it redirects
// to its workspace) and a session (a thread). Every other route is null, so
// the components hide the link instead of opening a page Lumen does not have.
setUiRoutes({
  sessions: () => null,
  files: () => null,
  drive: () => null,
  apps: () => null,
  members: () => null,
  sandboxSettings: () => null,
  customize: () => null,
});

// The controls a customer-facing app shows. Members reach Kortix only through
// the proxy allowlist (src/server/proxy-policy.ts), so a control whose route it
// refuses is off: no CLI "connect from your machine" bar, no public share links
// (Kortix would serve them under its own brand) and no terminal (a Next.js
// route handler cannot upgrade its WebSocket). Kortix-managed models stay on.
//
// `accountApiEnabled` stays on, on purpose. With it off, @kortix/ui treats
// every permission as allowed ("host enforced") and fires the configuration
// reads behind those controls (agent config, connectors, model defaults), which
// the proxy refuses with 403. With it on, the UI asks the permission probes,
// the proxy answers them itself with "denied" (`localAnswer`), and the UI
// hides those controls and sends none of those reads.
// @kortix/ui's composer hints speak of projects, agents and files. Lumen's speak of matters and documents.
const i18n: UiI18nHost = {
  messages: {
    ...defaultUiMessages,
    threads: {
      ...defaultUiMessages.threads,
      hintSkills: 'Ask about a clause, a party or a date',
      hintMentions: 'Name a document to focus the answer on it',
      hintWorkspaceFile: 'Ask about any document in this matter',
      hintSwitchAgents: 'Ask for a short answer with citations',
      hintAttachFiles: 'Drop a contract here to add it to Documents',
      hintChanged: 'Ask which agreements depart from your playbook',
      hintCompact: 'Ask for a one-paragraph summary',
      startingSession: 'Starting a secure workspace…',
      sessionStarted: 'Conversation started',
      failedToStartSession: 'Could not start the conversation',
    },
  },
};

// A lawyer's Assistant shows no infrastructure: no model or effort picker (the
// firm's default model runs), no context ring, no session-overrides gear
// (sandbox, provider, folders). A session runs on its matter's Kortix agent
// (convex/lumenAgent.ts) in the one shared project: the firm's agent
// (`lumen-f-<firmId>`), or a restricted matter's own (`lumen-m-<matterId>`).
// The proxy lists only that agent in the project detail and pins it on every
// session it creates, so the picker, the print header and every other agent
// label show one name: Counsel. The reviewer, extractor and drafter are kit
// roles a run names in input.json.
const LUMEN_AGENT = /^lumen-[fm]-/;
const agentLabels: Readonly<Record<string, string>> = new Proxy({} as Record<string, string>, {
  get: (_target, name) => (typeof name === 'string' && LUMEN_AGENT.test(name) ? 'Counsel' : undefined),
});

const config: Partial<UiHostConfig> = {
  cliConnectEnabled: false,
  publicSharesEnabled: false,
  terminalEnabled: false,
  managedModelsEnabled: true,
  modelPickerEnabled: false,
  contextMeterEnabled: false,
  sessionOverridesEnabled: false,
  agentLabels,
  // "/" lists Lumen's workflows, never the harness's commands or Compact session (UXR3-1).
  runtimeSlashEnabled: false,
  useSlashActions: useLumenSlashActions,
  // A file attached in a chat goes into the matter's Documents, the one path that reads,
  // anchors and indexes it: only a vault document can be cited. Nothing reaches the session's own store.
  takeFiles: (files) => void addToDocuments(files),
  attachAccept: VAULT_ACCEPT,
};

async function addToDocuments(files: File[]) {
  const matterId = getActiveMatter();
  if (!matterId) return errorToast('Open a matter to add documents');
  for (const file of files) {
    const refused = refuseReason(file);
    if (refused) {
      errorToast(`${file.name}: ${refused}`);
      continue;
    }
    try {
      await convex.action(api.documents.upload, {
        matterId: matterId as Id<'matters'>,
        filename: file.name,
        bytes: await file.arrayBuffer(),
        contentType: file.type,
      });
      successToast(`${file.name} added to Documents`, { description: 'Lumen reads it now. Ask about it once it shows Ready in Documents.' });
    } catch (err) {
      errorToast(`${file.name}: could not add it`, { description: errorText(err) });
    }
  }
}

// Lumen's own backend: orgs, workspaces, threads. Better Auth runs inside it.
// The fallback is the `convex dev` local default, so a build without env still compiles.
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL || 'http://127.0.0.1:3210');

// @convex-dev/better-auth@0.12.5 types its prop for a client without extra
// plugins; the organization plugin's session type does not unify with it.
// The runtime object is the same client.
const providerAuthClient = authClient as unknown as AuthClient;

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Flawless freshness: revalidate on focus/reconnect, short stale window.
            staleTime: 10_000,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            retry: 1,
          },
        },
      }),
  );

  return (
    <ConvexBetterAuthProvider client={convex} authClient={providerAuthClient}>
      <QueryClientProvider client={queryClient}>
        {/* @kortix/ui's host adapters: links and router calls navigate with
            next/link and next/navigation; copy keeps the English defaults; images
            stay plain <img> (next/image would need images.remotePatterns for
            organization logos); the brand is Lumen's mark; sandbox previews resolve
            through Lumen's server. IconProvider gives every Phosphor icon the house
            weight. Mounted once. */}
        <UiProvider
          link={NextLink}
          navigation={navigation}
          config={config}
          i18n={i18n}
          useBrand={useLumenBrand}
          resolvePreviewUrl={resolveLumenPreviewUrl}
        >
          <IconProvider>
            <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
            <Toaster />
          </IconProvider>
        </UiProvider>
      </QueryClientProvider>
    </ConvexBetterAuthProvider>
  );
}
