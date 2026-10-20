# @kortix/ui module entries

One curated barrel per module. Every name below is public API (semver). Each piece needs
`<UiProvider>` and a `QueryClientProvider` at the root; a missing `UiHostComponents` slot hides its control.
`SessionThread`, `SessionWorkspace` and `ProjectHome` mount `SessionIdsProvider` and the SDK project scope
themselves. Any other block that reads a project needs both around it: `KortixProjectProvider`
(`@kortix/sdk/react`) and `SessionIdsProvider` (`@kortix/ui`); the composer example shows it.

Deep paths (`@kortix/ui/internal/*`, `@kortix/ui/<module>/<path>`) exist only for the files in
`scripts/deep-exports.json` and carry no semver: import the entry.

Each example compiled with `tsc --noEmit` in a Vite + React 19 app that installed the packed tarballs,
and rendered against a live API with 0 console errors (terminal and side panel inside `SessionWorkspace`).
`src/skill.test.ts` fails when an entry exports a name this file does not list.

## `@kortix/ui/icons`

Source: `src/icons/index.ts`. The glyphs the library draws with its own markup.

Props: each glyph takes SVG props.

```tsx
import { Button } from '@kortix/ui';
import { Close } from '@kortix/ui/icons';

export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
      <Close />
    </Button>
  );
}
```

Names: `Close`, `Copy`, `SidebarGlyph`

## `@kortix/ui/theme`

Source: `src/theme/index.ts`. White-label theming: tokens to CSS, a themed subtree, the session wallpapers.

Props: `ThemeScope`: `theme`, `className`, any `div` prop. `themeToCss(theme, selector?)`. Every key: `theming.md`.

```tsx
import { ThemeScope, type KortixTheme } from '@kortix/ui/theme';
import type { ReactNode } from 'react';

const preview: KortixTheme = { light: { blue: '#7c3aed', ring: '#7c3aed' }, radius: '1rem' };

// One subtree in another brand; its dialogs and menus portal into the same theme.
export function Preview({ children }: { children: ReactNode }) {
  return <ThemeScope theme={preview} className="bg-background">{children}</ThemeScope>;
}
```

Names: `THEME_COLOR_VARS`, `themeToCss`, `themeToCssVars`, `KortixTheme`, `ThemeColor`, `ThemeColors`, `ThemeCssVars`, `ThemeDurationStep`, `ThemeEasing`, `ThemeShadowStep`, `ThemeTextStep`, `ThemeScope`, `ThemeScopeProps`, `DEFAULT_WALLPAPER_ID`, `WALLPAPERS`, `getWallpaperById`, `Wallpaper`

## `@kortix/ui/i18n`

Source: `src/i18n/index.ts`. Translations: next-intl-compatible hooks over the host adapter or the bundled English catalog.

Props: `useTranslations(namespace)` returns `t` (`t.rich`, `t.markup`, `t.raw`, `t.has`); `useLocale()`.

```tsx
import { useLocale, useTranslations } from '@kortix/ui/i18n';

// The same catalog the components read: your UiProvider i18n, or bundled English.
export function Untitled() {
  const t = useTranslations('sidebar');
  return <span lang={useLocale()}>{t('sessionList.empty')}</span>;
}
```

Names: `createTranslator`, `UiI18nHost`, `localizeUiCatalog`, `translateUiCatalogText`, `useLocalizedUiCatalog`, `UiMessages`, `defaultUiMessages`, `UiUseTranslations`, `UiTranslator`, `useTranslations`, `useLocale`

## `@kortix/ui/markdown`

Source: `src/markdown/index.tsx`. Assistant and document markdown: code, math, links, GenUI fences, frontmatter.

Props: `UnifiedMarkdown`: `content`, `trust` (`'agent'` for model text), `variant` (`'document'` for a file), `documentPath`, `isStreaming`, `className`.

```tsx
import { UnifiedMarkdown } from '@kortix/ui/markdown';

// trust: who wrote it. 'agent' text is not your own HTML.
export function Answer({ text }: { text: string }) {
  return <UnifiedMarkdown content={text} trust="agent" />;
}
```

Names: `markdownPolicy`, `MarkdownPolicy`, `MarkdownTrust`, `MarkdownVariant`, `UnifiedMarkdown`, `UnifiedMarkdownProps`, `CopyOverlay`, `HighlightedCode`, `CopyButton`, `MarkdownWithFrontmatter`, `languageLabel`, `normalizeLanguage`

## `@kortix/ui/genui`

Source: `src/markdown/genui/index.ts`. Typed UI blocks inside assistant markdown: the block renderer, the component set, telemetry, copy-as-text.

Props: none to mount: `UnifiedMarkdown` renders GenUI fences.

```tsx
import { mayHoldGenui } from '@kortix/ui/genui';
import { UnifiedMarkdown } from '@kortix/ui/markdown';

// GenUI fences render inside UnifiedMarkdown; mayHoldGenui is a cheap pre-check.
export function Reply({ text }: { text: string }) {
  return <UnifiedMarkdown content={text} trust="agent" className={mayHoldGenui(text) ? 'min-h-24' : undefined} />;
}
```

Names: `GenuiFenceBoundary`, `GenuiTelemetryContext`, `GenuiTelemetryScope`, `GenuiPending`, `genuiComponents`, `GenuiMessageBlock`, `GenuiBlock`, `copyGenuiText`, `genuiCopyText`, `mayHoldGenui`, `useGenuiCopyMessages`, `GenuiForceEnabledContext`, `useGenuiEnabled`

## `@kortix/ui/diff`

Source: `src/diff/index.ts`. One file diff (split or unified).

Props: `DiffView`: `patch` (a unified diff of one file), or `before` + `after` (`{ name, contents }`).

```tsx
import { DiffView } from '@kortix/ui/diff';

export function ConfigDiff() {
  return (
    <DiffView
      before={{ name: 'config.yaml', contents: 'mode: draft\n' }}
      after={{ name: 'config.yaml', contents: 'mode: live\n' }}
    />
  );
}
```

Names: `DiffView`

## `@kortix/ui/changes`

Source: `src/changes/index.ts`. A file-by-file change list and its vocabulary.

Props: `ChangeList`: `entries` (`ChangeEntry[]`), `layout` (`'unified'` or `'split'`), `expanded`, `onRowOpenChange`. `useChangeExpansion(entries)` returns them.

```tsx
import { ChangeList, useChangeExpansion, type ChangeEntry } from '@kortix/ui/changes';

// `patch` is one file's unified diff with its headers, as `git diff` prints it.
const patch = '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Draft\n+Live\n';
const entries: ChangeEntry[] = [{ path: 'README.md', kind: 'modified', additions: 1, deletions: 1, patch }];

export function Changes() {
  const { expanded, setRow } = useChangeExpansion(entries);
  return <ChangeList entries={entries} layout="unified" expanded={expanded} onRowOpenChange={setRow} />;
}
```

Names: `ChangeList`, `ChangeSummary`, `DiffLayoutToggle`, `ExpandAllButton`, `useChangeExpansion`, `CHANGE_KIND`, `DIFF_LAYOUT_LABEL`, `PROPOSED_CHANGE_STATE`, `changeKind`, `diffViewportClass`, `entryFromCommitFile`, `entryFromVcsFile`, `fileCount`, `initiallyExpanded`, `proposedChangeTimeline`, `shouldReseedExpansion`, `splitPath`, `splitUnifiedPatch`, `totalChanges`, `ChangeEntry`, `ChangeKind`, `ChangeTotals`, `DiffLayout`, `ProposedChangeStatus`

## `@kortix/ui/files`

Source: `src/files/index.ts`. Browse and edit files. Project files are the git-backed repo; sandbox files are a live session workspace.

Mount: Project files: inside `ProjectFilesProvider` (`projectId`, optional git `ref`). Sandbox files: inside a mounted `useSession`. `FilePreviewHost`: once, on a page with no session side panel; a file open (`openPreview`) shows there. `SessionThread` mounts it already.

Props: `ProjectFilesView` (`@kortix/ui/workspace`): `projectId`. `FileExplorerPage`: `embedded`. `SandboxFileExplorer`: `embedded`, `shareContext`, `leading`. `FilePreviewHost`: none.

```tsx
import { FilePreviewHost } from '@kortix/ui/files';
import { ProjectFilesView } from '@kortix/ui/workspace';

// The project's git-backed files: browse, open any file in the viewer.
export function Files({ projectId }: { projectId: string }) {
  return <ProjectFilesView projectId={projectId} />;
}

// Once per page that has no side panel: file opens show in a dialog here.
export function PreviewHost() {
  return <FilePreviewHost />;
}
```

Names: `saveDriveFile`, `useDismissDriveConflict`, `useDriveAvailability`, `useDriveConflicts`, `useDriveFolder`, `useFolderAccess`, `useFolderPrincipals`, `useInvalidateDrives`, `useProjectDrive`, `useShareFolder`, `useUnshareFolder`, `FilesStoreProvider`, `getFileIcon`, `FilePreviewHost`, `ChangeRequestDetailDialog`, `DiffRenderer`, `DriveExplorer`, `FileExplorerPage`, `FileThumbnail`, `ProjectFilesProvider`, `useProjectContext`, `FileExplorerSourceProvider`, `ExplorerQueryResult`, `FileExplorerSource`, `gitRefExplorerSource`, `useChangeRequestRecovery`, `changeRequestKeys`, `openChangeRequestListQuery`, `useChangeRequestDiff`, `useChangeRequestMergePreview`, `useCloseChangeRequest`, `useMergeChangeRequest`, `useRequestChangesOnChangeRequest`, `useSelectedVersion`, `workspaceFileSource`, `useWorkspaceSearch`, `SandboxFileExplorer`

## `@kortix/ui/file-viewer`

Source: `src/files/viewer/index.ts`. Render any file kind (pdf, docx, xlsx, csv, pptx, zip, images, code) from a byte source.

Mount: Inside `FileSourceProvider` (where the bytes come from).

Props: `FileViewer`: `content`, `fileName`, optional `path`, `onClose`, `refresh`, `className`. `FileContentRenderer`: `filePath`, `showHeader`, `readOnly`, `targetLine`, `onSaved`. `FileSource`: `id`, `useFileContent`, `useBinaryBlob`, `download`, `upload`, optional `save`, `bytesOnly`.

```tsx
import { FileViewer } from '@kortix/ui/file-viewer';

// Text you already hold, rendered by kind (markdown, code, csv, ...).
export function Note({ text }: { text: string }) {
  return <FileViewer content={text} fileName="notes.md" />;
}
```

Names: `FileContentRenderer`, `FileContentRendererProps`, `FilePreviewModal`, `FilePreviewModalProps`, `FilePreviewState`, `FileSourceProvider`, `useFileSource`, `BinaryBlobResult`, `FileContent`, `FileContentResult`, `FilePatch`, `FilePatchHunk`, `FileSource`, `HtmlPreview`, `PreviewFitProvider`, `isUsableIntrinsicSize`, `SaveAsPdfButton`, `framePolicy`, `getFileCategory`, `getLanguageFromExt`, `FileCategory`, `FrameContent`, `FramePolicy`, `FileViewer`, `ShowCarouselItem`

## `@kortix/ui/terminal`

Source: `src/terminal/index.ts`. The session terminal (one ambient shell per session).

Mount: Inside a mounted `useSession` (the PTY client comes from `@kortix/sdk/react`).

Props: `SessionTerminal`: `sessionId` (runtime id), `projectId`, `projectSessionId`, `hidden`.

```tsx
import { SessionTerminal } from '@kortix/ui/terminal';

// The session's shell. runtimeSessionId comes from useSession(...).runtimeSessionId.
export function Shell(props: { runtimeSessionId: string; projectId: string; sessionId: string }) {
  return (
    <div className="h-96">
      <SessionTerminal sessionId={props.runtimeSessionId} projectId={props.projectId} projectSessionId={props.sessionId} />
    </div>
  );
}
```

Names: `SessionTerminal`, `shouldPaintFatalCard`, `shouldPaintTerminalCard`

## `@kortix/ui/browser`

Source: `src/browser/index.ts`. The sandbox browser tab.

Mount: Inside a mounted `useSession`.

Props: `BrowserLanding`: `projectId`, `recents`, `onOpen(url)`, `empty`. `SessionBrowser`: `tabId`, `projectId`, `projectSessionId` (a tab of the session panel).

```tsx
import { BrowserLanding } from '@kortix/ui/browser';

// The browser tab's start page: recent URLs, open one.
export function Start({ projectId, onOpen }: { projectId: string; onOpen: (url: string) => void }) {
  return <BrowserLanding projectId={projectId} recents={[]} onOpen={onOpen} />;
}
```

Names: `BrowserLanding`, `SessionBrowser`

## `@kortix/ui/apps`

Source: `src/apps/index.ts`. Live App frames, the frame pool and the App view model.

Props: `AppPreview`: `app`, `url`, `interactive`, `className`.

```tsx
import { isKortixAppUrl } from '@kortix/ui/apps';

export function AppLink({ url }: { url: string }) {
  return <a href={url}>{isKortixAppUrl(url) ? 'Open App' : url}</a>;
}
```

Names: `AppPreview`, `AppPreviewOverlay`, `PREVIEW_SPINNER_DELAY_MS`, `PREVIEW_TILE_ASPECT`, `PREVIEW_VIEWPORT_HEIGHT`, `PREVIEW_VIEWPORT_WIDTH`, `framePlacement`, `previewScale`, `scheduleSlowPreview`, `ensureFrame`, `frameKey`, `framesKeepAlive`, `pruneFrames`, `reloadFrame`, `ANONYMOUS_MODES`, `DEPLOYMENT_COPY`, `appCan`, `appCommand`, `appHost`, `appStatus`, `appTabLabel`, `cardPreviewApp`, `childApps`, `deployNotice`, `gridApps`, `localizedAppCopy`, `isKortixAppUrl`

## `@kortix/ui/composer`

Source: `src/session/composer/index.ts`. The message composer: drop-in inputs, chrome, tiptap editor parts and the send pipeline.

Mount: Inside a mounted session (`ComposerChatInput` also works on a project home, before a session exists).

Props: `ComposerChatInput`: `projectId`, `onSend(text, files, options, attachments)`, optional `sessionId`, `isBusy`, `disabled`, `placeholder`, `prefill`, slots (`aboveSlot`, `inputSlot`, `toolbarSlot`).

```tsx
import { KortixProjectProvider } from '@kortix/sdk/react';
import { SessionIdsProvider } from '@kortix/ui';
import { ComposerChatInput } from '@kortix/ui/composer';

// The composer alone, before a session exists: you decide what a send does.
// Outside SessionThread / SessionWorkspace / ProjectHome, mount the two scopes
// they mount for you: the SDK's project (model catalog) and the UI's ids.
export function Ask({ projectId, onAsk }: { projectId: string; onAsk: (text: string) => void }) {
  return (
    <KortixProjectProvider projectId={projectId}>
      <SessionIdsProvider projectId={projectId}>
        <ComposerChatInput projectId={projectId} onSend={(text) => onAsk(text)} />
      </SessionIdsProvider>
    </KortixProjectProvider>
  );
}
```

Names: `ComposerAboveCard`, `ComposerCard`, `AgentSelector`, `agentDisplayLabel`, `captureAttachmentSubmission`, `runComposerSend`, `AttachmentSubmission`, `COMMAND_CHIP_ATTRIBUTE`, `COMMAND_CHIP_LABEL_ATTRIBUTE`, `COMMAND_CHIP_SELECTOR`, `COMMAND_CHIP_VALUE`, `draftWillRunCommand`, `planCommandAttachments`, `planUnresolvedCommandChip`, `readCommandChipLabel`, `COMPOSER_INPUT_SLOT_CLASS`, `COMPOSER_SHELL_CLASS`, `Composer`, `ComposerChatInput`, `ComposerOptions`, `ComposerDropZone`, `ComposerUnderbar`, `DraftScope`, `ComposerEditor`, `ComposerEditorHandle`, `baseExtensions`, `MentionNode`, `baseSuggestion`, `MenuController`, `ReasoningEffortSelector`, `SessionChatInput`, `SessionChatInputProps`, `useFirstPromptPreviewStore`, `useSessionComposerPrefillStore`, `createSubmitLatch`, `AttachedFile`

## `@kortix/ui/session`

Source: `src/session/index.ts`. The conversation: the drop-in thread, turns, tool rows, prompts, status, pickers, session operations.

Mount: Pass the `useSession(projectId, sessionId)` result: `<SessionThread session={session} />`. Importing the entry registers the built-in tool rows.

Props:
- `SessionThread`: `session` (required), `hideHeader`, `readOnly`, `className`. Without a side panel on the page, file and preview opens show in a dialog.
- `ToolRegistry.register(name, Row)`: `Row` gets `ToolProps` (`call`: `name`, `input`, `status`, `result`); `BasicTool` draws the standard row.
- `ModelPicker`, `AgentPicker`: controlled pickers over a plain list, for a form outside a session.

```tsx
import { useSession } from '@kortix/sdk/react';
import { SessionThread } from '@kortix/ui/session';

// The whole thread of one session; the parent sets the height.
export function Chat({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  return <SessionThread session={useSession(projectId, sessionId)} hideHeader className="h-dvh" />;
}
```

Names: `SessionThread`, `SessionThreadProps`, `UserMessage`, `ThrottledMarkdown`, `UnifiedMarkdown`, `UnifiedMarkdownProps`, `ToolPartRenderer`, `ToolRegistry`, `BasicToolProps`, `ToolComponent`, `ToolProps`, `BasicTool`, `GenericTool`, `SessionChatInput`, `SessionChatInputProps`, `AgentSelector`, `ModelSelector`, `ModelSelectorProps`, `SessionPermissionPrompt`, `QuestionPrompt`, `QuestionPromptHandle`, `TurnErrorDisplay`, `SessionBusyIndicator`, `SessionStartingLoader`, `SessionStatus`, `UNTITLED_SESSION_LABEL`, `getSessionDisplayTitle`, `groupChangeRequestsBySession`, `hasSessionAwaitingTitle`, `isAwaitingTitle`, `projectSessionsRefetchInterval`, `resolveSessionListViewState`, `sessionLastActivityAt`, `sessionTitleHasLanded`, `shortRelative`, `sortSessionsByLastActivity`, `starterSectionOf`, `SessionDeleteModal`, `isLegacyMigratedSession`, `matchesSourceFilters`, `matchesStatusFilters`, `sessionDisplayLabel`, `sessionSource`, `SessionSourceFilter`, `useRenameSession`, `useSessionListActions`, `CompactModal`, `ProviderFailureRecovery`, `useModelConnectionGate`, `AgentPicker`, `ModelPicker`, `filterModels`, `ApprovalAgentContext`, `ApprovalDecisionActions`, `ApprovalParameters`, `approvalReviewable`, `useApprovalWaitingText`, `SessionApprovalNotice`, `createScopedSession`, `SandboxLoadingBoundary`, `SessionNoticeBanner`, `SessionConnectingBanner`, `ChatMinimap`, `SessionChat`, `SessionTurn`, `TranscriptTurnRow`, `TurnAssistantBlock`, `ToolSurfaceContext`, `partOutcome`, `ToolOutcomeContext`, `ToolOutputFallback`, `ServicePreviewActions`, `ServicePreviewState`, `ServicePreviewViewport`, `ToolActivateContext`, `TurnLiveContext`, `ActivityBurst`, `PlanCard`, `TurnViewport`, `ATTACHMENT_TILE_CAP`, `BUBBLE_SURFACE`, `ChannelOrigin`, `UserMessageBubble`, `mergeSentAttachments`, `normalizeAttachments`, `planAttachmentGrid`, `ChannelMessage`, `NormalizedAttachment`

## `@kortix/ui/session-panel`

Source: `src/session/panel/index.ts`. The session side panel: provider, panel bodies, files, changes and audit views, run read models.

Mount: Inside `SessionPanelProvider` (`sessionId`, `projectId`, `projectSessionId`).

Props: `SessionPanelProvider`: `sessionId` (runtime id), `projectId`, `projectSessionId`, `isSessionBusy`. `ActionPanel` takes none. `openSessionQuickView(view, source, target?)` opens a view (`browser`, `terminal`, `files`, `audit`) in the panel; with no panel mounted, `SessionThread` shows it in a dialog.

```tsx
import { ActionPanel, SessionPanelProvider } from '@kortix/ui/session-panel';

// The side panel on its own, beside your own thread layout.
export function Panel(props: { runtimeSessionId: string; projectId: string; sessionId: string }) {
  return (
    <SessionPanelProvider
      sessionId={props.runtimeSessionId}
      projectId={props.projectId}
      projectSessionId={props.sessionId}
    >
      <ActionPanel />
    </SessionPanelProvider>
  );
}
```

Names: `ActionPanel`, `AdvancedPanel`, `DiffDialog`, `EasyPanel`, `openSessionQuickView`, `SessionAudit`, `useSessionAudit`, `SessionFiles`, `SessionChanges`, `SessionPanelContext`, `SessionPanelProvider`, `useOptionalSessionPanel`, `SessionPanelValue`, `collectAllToolCalls`, `latestRunMessages`, `deriveRunOutcome`

## `@kortix/ui/workspace`

Source: `src/workspace/index.ts`. Composed project screens: session workspace, project sidebar, sessions list, project home, permission and route helpers.

Mount: `SessionWorkspace` takes `session` (the `useSession` result): the thread plus the resizable side panel. `children` replaces the thread. `SessionLayout` is the same layout with explicit ids (`sessionId` = runtime id, `projectId`, `projectSessionId`, `bootStage`, `transient`) and the thread as `children`. Project screens take `projectId`; `ProjectSessionList` mounts inside a `SidebarProvider`. `ProjectHome` sends by itself (`useProjectHomeSend`: create the session with the prompt, open it); `beforeSend` gates it, `onSend` replaces it.

Props:
- `SessionWorkspace`: `session` (the `useSession` result, required), `children` (replaces the thread), `hideHeader`, `readOnly`, `className`.
- `SessionLayout`: `sessionId` (runtime id), `projectId`, `projectSessionId`, `children` (the thread), `bootStage`, `transient`.
- `ProjectHome`: `projectId`; `beforeSend` (runs first, throw to refuse); `onSend` + `busy` (replace the send).
- `useProjectHomeSend(projectId, { beforeSend })` returns `{ send, sending }`.
- `ProjectSessionList`, `ProjectSessionsView`, `ProjectFilesView`: `projectId`. `ProjectSidebar`: `projectId`, `menu`, `onOpenSearch` (the header shows Search only with it); its Files, Apps and Customize rows read `projectId`, not the route.

```tsx
import { useSession } from '@kortix/sdk/react';
import { SidebarProvider } from '@kortix/ui/sidebar';
import { ProjectHome, ProjectSessionList, SessionWorkspace } from '@kortix/ui/workspace';

// Thread plus the resizable side panel (files, viewer, terminal, browser, changes).
export function Session({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  return <SessionWorkspace session={useSession(projectId, sessionId)} />;
}

// The project home composer: sending creates the session and opens it.
export function Home({ projectId }: { projectId: string }) {
  return <ProjectHome projectId={projectId} beforeSend={async () => {}} />;
}

// Kortix's session list; it links to /projects/<id>/sessions/<sessionId>.
export function Sessions({ projectId }: { projectId: string }) {
  return (
    <SidebarProvider>
      <ProjectSessionList projectId={projectId} />
    </SidebarProvider>
  );
}
```

Names: `ProjectPageHeader`, `useCapabilityAccess`, `useProjectNavRows`, `SidebarToggle`, `activeCapabilityTab`, `agentHref`, `capabilityTabHref`, `channelsHref`, `remindersHref`, `reviewHref`, `detectManifestVersion`, `manifestFilename`, `manifestNeedsUpgrade`, `useProjectManifestVersion`, `ManifestVersion`, `CUSTOMIZE_SECTION_ACCESS`, `CUSTOMIZE_SECTION_GATE_ACTIONS`, `PROJECT_ACTIONS`, `isCustomizeSectionVisible`, `CustomizeSection`, `ProjectAction`, `usePermission`, `usePermissions`, `usePermissionsFor`, `PROJECT_PAGE_ACTIONS`, `useProjectCan`, `useProjectCans`, `useProjectPageCans`, `CanResult`, `formatFireTime`, `nearestFire`, `reminderTitle`, `scheduleLabel`, `ProjectHomeWallpaper`, `ProjectHomeWelcomeBody`, `InstantSessionShell`, `ProjectFilesView`, `ProjectHome`, `ProjectHomeSendOptions`, `useProjectHomeSend`, `UseProjectHomeSendOptions`, `SavedSessionSkeleton`, `SessionLayout`, `SessionWorkspace`, `SessionLayoutProps`, `SessionWorkspaceProps`, `ProjectSessionsView`, `ProjectSessionList`, `ProjectSidebar`, `ShareSessionModal`

## `@kortix/ui/access`

Source: `src/access/index.ts`. Sharing and roles: access dialog, rows, role select, principal picker.

Mount: Takes the resource and its principals as props.

Props: `AccessDialog`: `open`, `onOpenChange`, `accountId`, `scope`, `mode`. `AccessRow`: `title`, `meta`, `leading`, `trailing`, `actions`, `onClick`. `RoleSelect`: `scope`, `accountId`, `value`, `onChange`.

```tsx
import { AccessRow } from '@kortix/ui/access';

export function Member({ name, role }: { name: string; role: string }) {
  return <AccessRow title={name} meta={role} />;
}
```

Names: `AccessDialog`, `AccessRow`, `PrincipalPicker`, `RoleSelect`

## `@kortix/ui/customize`

Source: `src/customize/index.ts`. Project configuration pages: connectors, agents, triggers, secrets, models, skills, settings.

Mount: Each page takes `projectId`.

Props: every page takes `projectId`; `AgentPage` also takes `agentName`.

```tsx
import { ConnectorsPage, SecretsPage } from '@kortix/ui/customize';

export function ProjectSetup({ projectId }: { projectId: string }) {
  return (
    <>
      <ConnectorsPage projectId={projectId} />
      <SecretsPage projectId={projectId} />
    </>
  );
}
```

Names: `AgentPage`, `AgentsPage`, `ConnectorsPage`, `ModelsPage`, `ProjectSettingsPage`, `SecretsPage`, `CapabilityPageShell`, `SkillsPage`, `TriggersPage`
