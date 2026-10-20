# Build a custom dashboard or App on @kortix/sdk + @kortix/ui

A React host with your own chrome around Kortix's whole session experience: a project list, a
sidebar with Kortix's session list, the project home composer, the session workspace (thread plus
side panel with files, viewer, terminal, browser), a project Files page, a company theme and a custom
tool row. Every sample below is a file of one Vite 8 + React 19 + react-router 7 app that installed
`@kortix/sdk` and `@kortix/ui` from their packed tarballs. It passed `tsc --noEmit` and `vite build`,
and ran against a live Kortix API: project list, a prompt from the home composer, the session opening,
the tool rows (the custom one included), the reply, the file in the side panel, the Files page and its
viewer, 0 console errors.

## Rules

1. **No raw `fetch` to the Kortix API.** Read with `@kortix/sdk/react` hooks, write with the
   `kortix` client. If the SDK lacks a call, the SDK gets it; the host never hand-rolls it.
2. **One client per host.** Call `createKortix` once, at module scope.
3. **`useSession(projectId, sessionId)` owns the session**: start, the sandbox, the live stream,
   the transcript. Pass its result to `SessionWorkspace` or `SessionThread`. Never write a transport.
4. **Compose the modules, never fork them.** Your chrome goes around them; your brand goes in the theme.
5. **Never put an API key in the bundle.** `getToken` reads it at call time: a sign-in token, a
   key the person pastes, or a same-origin proxy that adds it on the server.

## 1. Install

```sh
npm i @kortix/sdk @kortix/ui @tanstack/react-query @phosphor-icons/react react react-dom react-router-dom
npm i @openuidev/lang-core@0.3.1 zod   # optional peers of @kortix/sdk; the thread renders genui blocks
npm i tw-animate-css tailwind-scrollbar tailwind-scrollbar-hide   # Tailwind v4 hosts only
```

`@kortix/ui` is not on npm yet. Inside `kortix-ai/suna`, use `"workspace:*"`. Outside it, install
the tarballs that `npm pack` makes in `packages/llm-catalog`, `packages/sdk` and `packages/ui`
after `node ../../scripts/stage-npm-publish.mjs` (what `packages/ui/scripts/smoke-install.mjs` does).
Without `@openuidev/lang-core`, `vite build` fails with `Missing export` in `@kortix/sdk/dist/genui`.
npm prints `ERESOLVE overriding peer dependency` for `cmdk` on React 19; the install succeeds.

## 2. Styles

```css
/* src/app.css: a Tailwind v4 host (Vite: add @tailwindcss/vite to plugins) */
@import 'tailwindcss';
@import '@kortix/ui/tailwind.css';
```

A host without Tailwind imports `@kortix/ui/styles.css` once instead: every class the package uses,
none of yours. Style your own markup with plain CSS over `var(--border)`, `var(--muted)`.
Never import `@kortix/ui/fonts.css` outside Kortix surfaces: Roobert is Kortix-only.

## 3. The client

```ts
// src/kortix.ts
import { createKortix } from '@kortix/sdk';

const TOKEN_KEY = 'kortix_token';

export function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token.trim());
}

// One client per host, created once at module scope. Every @kortix/sdk/react
// hook and every @kortix/ui/session component reads it.
export const kortix = createKortix({
  backendUrl: import.meta.env.VITE_KORTIX_API_URL ?? 'https://api.kortix.com/v1',
  getToken: async () => readToken(),
});
```

The browser origin must be in the API's CORS list. In local development against an API that does
not list it, proxy `/v1` through the dev server (Vite: `server.proxy['/v1']`) and point `backendUrl`
at the dev server's own origin.

**Inside a Kortix App**, the client acts as the person who opened the App. Run
`kortix apps access <app> --viewer api` once, then:

```ts
import { createKortix, kortixAppViewerToken } from '@kortix/sdk';

export const kortix = createKortix({ backendUrl: '/_kortix/api/v1', getToken: kortixAppViewerToken() });
```

Never give an App a personal PAT or API key. The `kortix-apps` skill has the deploy steps.

## 4. Theme, router adapters, providers

```ts
// src/theme.ts
import type { KortixTheme } from '@kortix/ui/theme';

// The company brand. Every field is optional: an unset one keeps the Kortix value.
export const acmeTheme: KortixTheme = {
  light: { blue: '#0f766e', ring: '#0f766e', border: '#cbd5e1', muted: '#f1f5f9' },
  dark: { blue: '#2dd4bf', ring: '#2dd4bf', border: '#334155', muted: '#1e293b' },
  radius: '0.375rem',
  fonts: { sans: 'Georgia, "Times New Roman", serif' },
};
```

Every key, default and limit: `theming.md`.

```tsx
// src/router-adapters.tsx
import type { UiLinkComponent, UiNavigation, UiRouter } from '@kortix/ui';
import { useMemo } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

// @kortix/ui links and router calls go through your router, not full page loads.
export const RouterLink: UiLinkComponent = ({ href, prefetch: _prefetch, ...props }) => (
  <Link to={href} {...props} />
);

function useUiRouterAdapter(): UiRouter {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (href) => navigate(href),
      replace: (href) => navigate(href, { replace: true }),
      prefetch: () => {},
      back: () => navigate(-1),
    }),
    [navigate],
  );
}

export const navigation: UiNavigation = {
  useRouter: useUiRouterAdapter,
  usePathname: () => useLocation().pathname,
  useSearchParams: () => useSearchParams()[0],
  useParams: () => useParams(),
};
```

```tsx
// src/providers.tsx
import { UiProvider } from '@kortix/ui';
import { IconProvider } from '@kortix/ui/icon-provider';
import { themeToCss } from '@kortix/ui/theme';
import { Toaster } from '@kortix/ui/toast';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import './kortix';
import { navigation, RouterLink } from './router-adapters';
import { acmeTheme } from './theme';

const themeCss = themeToCss(acmeTheme);
// The deployment serves its managed model lineup: the model picker lists it.
const config = { managedModelsEnabled: true };

// Mount inside the router: `navigation` calls its hooks.
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <UiProvider link={RouterLink} navigation={navigation} config={config}>
        <IconProvider>
          <style href="acme-theme" precedence="default">{themeCss}</style>
          {children}
          <Toaster />
        </IconProvider>
      </UiProvider>
    </QueryClientProvider>
  );
}
```

`QueryClientProvider`, `UiProvider` and one `<Toaster />` are required. `UiProvider` also mounts the
motion features: without it, expanded rows stay at height 0. Every `UiProvider` prop is optional;
pass stable objects (module scope):

| Prop | Default | A host passes |
| --- | --- | --- |
| `link` | a plain `<a>` | its router's link, called with `href` |
| `navigation` | full page loads; `usePathname` / `useSearchParams` read `window.location` | `{ useRouter, usePathname, useSearchParams, useParams }` of its router |
| `config` | `{ billingEnabled: false, connectorsEnabled: true, managedModelsEnabled: false }` | `managedModelsEnabled: true` when the deployment serves its model lineup |
| `components` | no slots: each control that opens one is hidden | `ShareSessionModal` (`@kortix/ui/workspace` exports Kortix's), `HomeAnnouncement`, `Wallpaper`, `ProjectProviderModal`, `ProviderAccountsModal`, `ConnectorConnectModal` |
| `useBrand` | the Kortix marks | a hook that returns `{ app_name, logo_url, icon_url }` |
| `image` | a plain `<img>` | its image component |
| `i18n` | the bundled English catalog | `{ useTranslations, useLocale }` (next-intl signatures) or `{ locale, messages }` |
| `strings` | English copy of the primitives | the keys it translates |
| `useViewerId` | no viewer | a hook that returns the signed-in user's id |

A Next.js host passes `next/link` and `{ useRouter, usePathname, useSearchParams, useParams }` from
`next/navigation` unchanged.

## 5. The project shell

Your sidebar chrome around Kortix's session list. The list links to
`/projects/<projectId>/sessions/<sessionId>`, so your router serves that path.

```tsx
// src/project-shell.tsx
import { SessionIdsProvider } from '@kortix/ui';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
} from '@kortix/ui/sidebar';
import { ProjectSessionList } from '@kortix/ui/workspace';
import { FolderSimpleIcon, NavigationArrowIcon, SquaresFourIcon } from '@phosphor-icons/react';
import { Link, Outlet, useLocation, useParams } from 'react-router-dom';

// Every project page: your sidebar chrome around Kortix's session list.
export function ProjectShell() {
  const { projectId = '', sessionId } = useParams();
  const { pathname } = useLocation();
  const nav = [
    { to: `/projects/${projectId}`, label: 'New session', icon: NavigationArrowIcon },
    { to: `/projects/${projectId}/files`, label: 'Files', icon: FolderSimpleIcon },
    { to: '/', label: 'All projects', icon: SquaresFourIcon },
  ];
  return (
    <SessionIdsProvider projectId={projectId} sessionId={sessionId}>
      <SidebarProvider>
        <Sidebar collapsible="offcanvas" variant="inset">
          <SidebarHeader className="px-3 py-2 text-sm font-medium">Acme Agents</SidebarHeader>
          <SidebarContent className="min-h-0">
            <SidebarGroup className="py-0">
              <SidebarMenu>
                {nav.map(({ to, label, icon: Icon }) => (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton asChild isActive={pathname === to}>
                      <Link to={to}>
                        <Icon />
                        <span>{label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
            {/* Kortix's session list: sections, status, rename, delete, live poll. */}
            <SidebarGroup className="min-h-0 flex-1 flex-col py-0">
              <ProjectSessionList projectId={projectId} />
            </SidebarGroup>
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="h-dvh min-h-0 overflow-hidden">
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </SessionIdsProvider>
  );
}
```

`ProjectSessionList` needs a `SidebarProvider` above it. `ProjectSidebar` (`@kortix/ui/workspace`)
is Kortix's whole sidebar, account and billing controls included; a host with its own chrome
composes the list as above.

## 6. The pages

```tsx
// src/pages.tsx
import { useProjects, useSession } from '@kortix/sdk/react';
import { Card, CardContent, CardHeader, CardTitle } from '@kortix/ui';
import Loading from '@kortix/ui/loading';
import { ProjectFilesView, ProjectHome, SessionWorkspace } from '@kortix/ui/workspace';
import { Link, useParams } from 'react-router-dom';

export function ProjectsPage() {
  const projects = useProjects();
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <h1 className="text-lg font-medium">Acme Agents</h1>
      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {projects.isLoading && <Loading />}
          {projects.data?.map((project) => (
            <Link key={project.project_id} to={`/projects/${project.project_id}`} className="hover:bg-accent rounded-md px-2 py-1.5">
              {project.name}
            </Link>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}

// The project home: Kortix's composer. Sending creates the session and opens it.
export function HomePage() {
  const { projectId = '' } = useParams();
  return <ProjectHome projectId={projectId} />;
}

// The session: the thread plus the resizable side panel (files, viewer, terminal, browser).
export function SessionPage() {
  const { projectId = '', sessionId = '' } = useParams();
  const session = useSession(projectId, sessionId);
  return <SessionWorkspace key={sessionId} session={session} />;
}

// The project's git-backed files: a browser, and a viewer for any file kind.
export function FilesPage() {
  const { projectId = '' } = useParams();
  return <ProjectFilesView projectId={projectId} />;
}
```

- `ProjectHome` sends by itself: it creates the session with the prompt and navigates to it.
  `beforeSend` gates the send (throw to refuse); `onSend` replaces it.
- `SessionWorkspace` is the thread plus the resizable side panel. Tool rows, clickable paths and the
  header's Files, Terminal and Browser buttons open in the panel. `key={sessionId}` remounts it per session.
- `ProjectFilesView` is the project's git-backed files: folders, files, history, and a viewer for
  any file kind. A live session's own workspace is the panel's Files view.
- The parent sets the height of each screen (`SidebarInset className="h-dvh min-h-0"`).

## 7. Routes

```tsx
// src/main.tsx
import { Button, Input, Label } from '@kortix/ui';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router-dom';

import './app.css';
import './shell-row';
import { readToken, saveToken } from './kortix';
import { FilesPage, HomePage, ProjectsPage, SessionPage } from './pages';
import { ProjectShell } from './project-shell';
import { Providers } from './providers';

function SignIn() {
  const [token, setToken] = useState(readToken());
  const [draft, setDraft] = useState('');
  if (token) return <Outlet />;
  return (
    <form
      className="mx-auto flex max-w-sm flex-col gap-3 p-8"
      onSubmit={(event) => {
        event.preventDefault();
        saveToken(draft);
        setToken(draft.trim());
      }}
    >
      <Label htmlFor="token">Kortix API key</Label>
      <Input id="token" type="password" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <Button type="submit" disabled={!draft.trim()}>
        Open dashboard
      </Button>
    </form>
  );
}

// Session URLs are /projects/:projectId/sessions/:sessionId: the session list links there.
const router = createBrowserRouter([
  {
    element: (
      <Providers>
        <SignIn />
      </Providers>
    ),
    children: [
      { path: '/', element: <ProjectsPage /> },
      {
        path: '/projects/:projectId',
        element: <ProjectShell />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'files', element: <FilesPage /> },
          { path: 'sessions/:sessionId', element: <SessionPage /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

## 8. A custom tool row

```tsx
// src/shell-row.tsx
import { BasicTool, ToolRegistry, type ToolProps } from '@kortix/ui/session';
import { TerminalWindowIcon } from '@phosphor-icons/react';

// Replaces the built-in row of the `bash` tool. A later register() for the same
// name wins; @kortix/ui/session registers its rows on import.
function ShellRow({ call }: ToolProps) {
  const command = (call.input as { command?: string } | null)?.command ?? '';
  const output = (call.result?.content ?? [])
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
  return (
    <BasicTool icon={<TerminalWindowIcon />} trigger={{ title: 'Shell', subtitle: command }}>
      <pre data-testid="acme-shell-output" className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
        {output || 'No output yet'}
      </pre>
    </BasicTool>
  );
}

ToolRegistry.register('bash', ShellRow);
```

- Import the file once at the entry (`import './shell-row'`). Never list it as side-effect-free.
- `call` is the session-log tool call: `name`, `kind`, `input`, `status` (`pending`, `running`,
  `complete`, `error`), `result.content` (text and attachment parts), `result.is_error`.
- `BasicTool` draws the standard row: the running state, the duration and the disclosure come from
  the thread. `GenericTool` is the default row for any tool.
- A tool from another harness falls back to its kind: `shell` calls draw the `bash` row.

## 9. Compose your own layout

The modules compose at any depth (`modules.md` has every entry with its props and an example):

- The thread alone: `SessionThread` (`@kortix/ui/session`). With no side panel on the page, file and
  preview opens show in a dialog. A page with neither mounts `<FilePreviewHost />` (`@kortix/ui/files`) once.
- Your own column beside Kortix's panel: `<SessionWorkspace session={session}>{yourThread}</SessionWorkspace>`.
- Your own panel: `SessionPanelProvider` + `ActionPanel` (`@kortix/ui/session-panel`), or
  `SessionTerminal` (`@kortix/ui/terminal`) with the session's `runtimeSessionId`.
- Blocks (`ComposerChatInput`, `ModelSelector`, `UserMessage`, `ToolPartRenderer`, …) outside the
  composed screens need the two scopes those screens mount: `KortixProjectProvider` (`@kortix/sdk/react`)
  and `SessionIdsProvider` (`@kortix/ui`) with the project and session ids.
- To draw every part yourself: `useChatTurns` and `renderParts` from `@kortix/sdk/react`
  (https://kortix.com/docs/sdk/react#build-a-chat-ui).
- Other data for a dashboard: `useProjectApps`, `useProjectTriggers`, `useChangeRequests`,
  `useGatewayOverview`, `useCan` (https://kortix.com/docs/sdk/react#hooks).

## 10. Verify

1. `tsc --noEmit` and the production build pass.
2. In a browser: the project list renders; a prompt from the home opens the session; the tool rows and
   your row draw; the reply streams; a file opens in the side panel; the Files page opens a file;
   0 console errors.
3. The theme computes: `getComputedStyle(document.documentElement).getPropertyValue('--radius')`
   and the thread's `font-family` show your values.
4. Light and dark (`dark` class on `<html>`), 720 × 480 and a phone width.
