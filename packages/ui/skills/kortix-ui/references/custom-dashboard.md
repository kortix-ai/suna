# Build a custom dashboard or App on @kortix/sdk + @kortix/ui

A React host that lists projects, lists sessions and embeds the Kortix session thread, in your
company's brand. Every sample below compiled with `tsc --noEmit` and `vite build` in a fresh
Vite 8 + React 19 app that installed both packages from their packed tarballs, and ran against a
live Kortix API (project list, new session, prompt round trip, custom tool row, custom theme).

## Rules

1. **No raw `fetch` to the Kortix API.** Read with `@kortix/sdk/react` hooks, write with the
   `kortix` client. If the SDK lacks a call, the SDK gets it; the host never hand-rolls it.
2. **One client per host.** Call `createKortix` once, at module scope. A second call re-points
   every earlier client.
3. **`useSession(projectId, sessionId)` owns the session**: start, the sandbox, the live stream,
   the transcript. Pass its result to `SessionThread` or to the blocks. Never write a transport.
4. **Theme with tokens, never fork a component.** A forked copy stops receiving fixes.
5. **Never put an API key in the bundle.** `getToken` reads it at call time: a sign-in token, a
   key the person pastes, or a same-origin proxy that adds it on the server.

## 1. Install

```sh
npm i @kortix/sdk @kortix/ui @tanstack/react-query @phosphor-icons/react react react-dom
npm i @openuidev/lang-core@0.3.1 zod   # optional peers of @kortix/sdk; the thread renders genui blocks
npm i tw-animate-css tailwind-scrollbar tailwind-scrollbar-hide   # Tailwind v4 hosts only
```

`@kortix/ui` is not on npm yet. Inside `kortix-ai/suna`, use `"workspace:*"`. Outside it, install
the tarballs that `npm pack` makes in `packages/llm-catalog`, `packages/sdk` and `packages/ui`
after `node ../../scripts/stage-npm-publish.mjs` (what `packages/ui/scripts/smoke-install.mjs` does).
Without `@openuidev/lang-core`, `vite build` fails with `Missing export` in `@kortix/sdk/dist/genui`.
npm prints `ERESOLVE overriding peer dependency` for `cmdk` on React 19; the install succeeds.

## 2. Styles

Pick one.

- **Tailwind v4 host** (your own classes resolve against the Kortix tokens):
  ```css
  /* src/app.css */
  @import 'tailwindcss';
  @import '@kortix/ui/tailwind.css';
  ```
  With Vite, add `@tailwindcss/vite` to `plugins`. `tailwind.css` scans the package for its classes.
- **No Tailwind**: `import '@kortix/ui/styles.css'` once. It holds every class the package uses
  and none of yours: style your own markup with plain CSS over `var(--border)`, `var(--muted)`.

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

The browser origin must be in the API's CORS list. For local development against an API that does
not list it, proxy `/v1` through the dev server (Vite: `server.proxy['/v1']`) and set `backendUrl`
to the dev server's own origin.

**Inside a Kortix App**, the client acts as the person who opened the App. Run
`kortix apps access <app> --viewer api` once, then:

```ts
import { createKortix, kortixAppViewerToken } from '@kortix/sdk';

export const kortix = createKortix({ backendUrl: '/_kortix/api/v1', getToken: kortixAppViewerToken() });
```

Never give an App a personal PAT or API key. The `kortix-apps` skill has the deploy steps.

## 4. Providers and theme

```tsx
// src/theme.ts
import type { KortixTheme } from '@kortix/ui/theme';

// The company brand: every field is optional, an unset one keeps the Kortix value.
export const acmeTheme: KortixTheme = {
  light: { blue: '#0f766e', ring: '#0f766e', border: '#94a3b8', muted: '#f1f5f9' },
  dark: { blue: '#2dd4bf', ring: '#2dd4bf', border: '#334155', muted: '#1e293b' },
  radius: '0.25rem',
  borderWidth: '2px',
  fonts: { sans: 'Georgia, "Times New Roman", serif' },
};
```

```tsx
// src/providers.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UiProvider } from '@kortix/ui';
import { IconProvider } from '@kortix/ui/icon-provider';
import { themeToCss } from '@kortix/ui/theme';
import { Toaster } from '@kortix/ui/toast';
import { useState, type ReactNode } from 'react';

import './kortix';
import { acmeTheme } from './theme';

const themeCss = themeToCss(acmeTheme);

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      {/* No props: plain <a> links, full page loads, the English catalog. */}
      <UiProvider>
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

- `QueryClientProvider`, `UiProvider` and one `<Toaster />` are required. `UiProvider` also mounts
  the motion features: without it, expanded rows stay at height 0.
- React 19 hoists `<style href precedence>` into `<head>`. A server-rendered host writes
  `themeToCss(theme)` into its `<head>` instead. `ThemeScope` themes one subtree (an embedded
  widget, a preview pane); its dialogs and menus portal into the same theme.
- Theme keys: `light` / `dark` colors (`blue` is the accent, `ring` focus, `border`, `muted`,
  `foreground`, `background`, `primary`, …), `radius`, `borderWidth`, `fonts.sans` / `fonts.mono`,
  `spacing`, `text`, `shadows`, `durations`, `easing`, `vars`. The full table is
  https://kortix.com/docs/sdk/ui#tokens.

### UiProvider props a host passes

Every prop is optional. Pass stable objects (module scope).

| Prop | Default | A host passes |
| --- | --- | --- |
| `link` | a plain `<a>` | its router's link, called with `href` |
| `navigation` | full page loads; `usePathname` / `useSearchParams` read `window.location` | `{ useRouter, usePathname, useSearchParams, useParams }` of its router |
| `image` | a plain `<img>` | its image component |
| `i18n` | the bundled English catalog | `{ useTranslations, useLocale }` (next-intl signatures) or `{ locale, messages }` |
| `strings` | English copy of the primitives | the keys it translates |
| `useViewerId` | no viewer | a hook that returns the signed-in user's id |
| `useBrand` | the Kortix marks | a hook that returns `{ app_name, logo_url, icon_url, … }` |
| `config` | `{ billingEnabled: false }` | its host flags |
| `components` | no slots: each control that opens one is hidden | `ShareSessionModal`, `ProjectProviderModal`, `ProviderAccountsModal`, `ConnectorConnectModal`, `Wallpaper` |

## 5. The dashboard

Project list, session list with "New session", and one embedded thread.

```tsx
// src/dashboard.tsx
import { generateSessionId } from '@kortix/sdk';
import { useProjectSessions, useProjects, useSession } from '@kortix/sdk/react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@kortix/ui';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@kortix/ui/empty';
import Loading from '@kortix/ui/loading';
import { SessionThread } from '@kortix/ui/session';
import { errorToast } from '@kortix/ui/toast';
import { useState } from 'react';

import { kortix } from './kortix';

export function Dashboard() {
  const projects = useProjects();
  const [picked, setPicked] = useState<string>();
  const projectId = picked ?? projects.data?.[0]?.project_id;
  const [sessionId, setSessionId] = useState<string>();

  return (
    <div className="grid h-dvh grid-cols-[18rem_1fr] bg-background text-foreground">
      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r p-4">
        <h1 className="text-lg font-medium">Acme Agents</h1>
        <Card>
          <CardHeader>
            <CardTitle>Projects</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {projects.isLoading && <Loading />}
            {projects.data?.map((project) => (
              <Button
                key={project.project_id}
                variant={project.project_id === projectId ? 'secondary' : 'ghost'}
                className="justify-start"
                onClick={() => {
                  setPicked(project.project_id);
                  setSessionId(undefined);
                }}
              >
                {project.name}
              </Button>
            ))}
          </CardContent>
        </Card>
        {projectId && <SessionList projectId={projectId} selected={sessionId} onSelect={setSessionId} />}
      </aside>
      <main className="min-h-0">
        {projectId && sessionId ? (
          <Thread key={sessionId} projectId={projectId} sessionId={sessionId} />
        ) : (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyTitle>No session open</EmptyTitle>
              <EmptyDescription>Pick a session or start a new one.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </main>
    </div>
  );
}

function SessionList({
  projectId,
  selected,
  onSelect,
}: {
  projectId: string;
  selected?: string;
  onSelect: (sessionId: string) => void;
}) {
  const { sessions, isLoading, refetch } = useProjectSessions(projectId, { limit: 20 });
  const [creating, setCreating] = useState(false);

  async function startSession() {
    setCreating(true);
    try {
      const sessionId = generateSessionId();
      await kortix.project(projectId).sessions.create({ session_id: sessionId, name: 'Dashboard session' });
      await refetch();
      onSelect(sessionId);
    } catch (error) {
      errorToast('Could not start a session', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <Button variant="brand" disabled={creating} onClick={startSession}>
          New session
        </Button>
        {isLoading && <Loading />}
        {sessions.map((session) => (
          <Button
            key={session.session_id}
            variant={session.session_id === selected ? 'secondary' : 'ghost'}
            className="justify-between"
            onClick={() => onSelect(session.session_id)}
          >
            <span className="truncate">{session.name ?? session.branch_name}</span>
            <Badge size="sm" variant="muted">
              {session.status}
            </Badge>
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}

// useSession owns the whole session: start, the live stream, the transcript.
function Thread({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useSession(projectId, sessionId);
  return <SessionThread session={session} hideHeader />;
}
```

- The parent sets the thread's height (`min-h-0` in a grid or flex parent); the thread fills it.
- `key={sessionId}` remounts the thread per session.
- `useProjectSessions` does not poll. Pass `refetchInterval` (ms) to keep `status` fresh.
- Other data for a dashboard: `useProjectApps`, `useProjectTriggers`, `useChangeRequests`,
  `useGatewayOverview`, `useCan` (https://kortix.com/docs/sdk/react#hooks).

## 6. A custom tool row

```tsx
// src/shell-row.tsx
import { TerminalWindowIcon } from '@phosphor-icons/react';
import { BasicTool, ToolRegistry, type ToolProps } from '@kortix/ui/session';

// Replaces the built-in row for the `bash` tool. A later register() for the
// same name wins, and @kortix/ui/session registers its rows on import.
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

- Import the file once at the entry (`import './shell-row'`). A module that only registers is a
  side effect: never list it as side-effect-free in your own `package.json`.
- `call` is the session-log tool call: `name`, `kind`, `input`, `status` (`pending`, `running`,
  `complete`, `error`), `result.content` (text and attachment parts), `result.is_error`.
- `BasicTool` draws the standard row: the running state, the duration and the open/close
  disclosure come from the thread. `GenericTool` is the default row for any tool.
- A tool from another harness falls back to its kind: `shell` calls draw the `bash` row.

## 7. Compose your own thread layout

`SessionThread` is the whole web thread. For another layout, compose the blocks of
`@kortix/ui/session` from the same `useSession` result: `UserMessage`, `ThrottledMarkdown`,
`UnifiedMarkdown`, `ToolPartRenderer`, `SessionChatInput`, `ModelSelector`, `AgentSelector`,
`SessionPermissionPrompt`, `QuestionPrompt`, `TurnErrorDisplay`, `SessionBusyIndicator`,
`SessionStartingLoader`. Wrap them in `SessionIdsProvider` (`@kortix/ui`) with the project and
session ids: the blocks read the ids from it, never from your route. Only `SessionThread` ran end to
end outside apps/web so far; test a block layout in a real session before you ship it. To draw every
part yourself, use `useChatTurns` and `renderParts` from `@kortix/sdk/react`
(https://kortix.com/docs/sdk/react#build-a-chat-ui).

Not exported yet: the side panel (files, terminal, browser) and the turn component.

## 8. Verify

1. `tsc --noEmit` and the production build pass.
2. In a browser: the project list renders, "New session" opens a thread, a prompt gets a reply,
   your tool row draws, 0 console errors.
3. The theme computes: `getComputedStyle(document.documentElement).getPropertyValue('--radius')`
   and the thread's `font-family` show your values.
4. Light and dark (`dark` class on `<html>`), 720 × 480 and a phone width.
