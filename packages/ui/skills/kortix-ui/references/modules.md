# @kortix/ui module entries

One curated barrel per module. Every name below is public API (semver). Each piece needs
`<UiProvider>` and a `QueryClientProvider` at the root; a missing `UiHostComponents` slot hides its control.
Deep paths (`@kortix/ui/<module>/<path>`) exist only for the files in `scripts/deep-exports.json` and carry no semver: import the entry.
`src/skill.test.ts` fails when an entry exports a name this file does not list.

## `@kortix/ui/icons`

Source: `src/icons/index.ts`. The glyphs the library draws with its own markup.

`Close`, `Copy`, `SidebarToggle`

## `@kortix/ui/theme`

Source: `src/theme/index.ts`. White-label theming: tokens to CSS, a themed subtree, the session wallpapers.

`THEME_COLOR_VARS`, `themeToCss`, `themeToCssVars`, `KortixTheme`, `ThemeColor`, `ThemeColors`, `ThemeCssVars`, `ThemeDurationStep`, `ThemeEasing`, `ThemeShadowStep`, `ThemeTextStep`, `ThemeScope`, `ThemeScopeProps`, `DEFAULT_WALLPAPER_ID`, `WALLPAPERS`, `getWallpaperById`, `Wallpaper`

## `@kortix/ui/i18n`

Source: `src/i18n/index.ts`. Translations: next-intl-compatible hooks over the host adapter or the bundled English catalog.

`createTranslator`, `UiI18nHost`, `localizeUiCatalog`, `translateUiCatalogText`, `useLocalizedUiCatalog`, `UiMessages`, `defaultUiMessages`, `UiUseTranslations`, `UiTranslator`, `useTranslations`, `useLocale`

## `@kortix/ui/markdown`

Source: `src/markdown/index.tsx`. Assistant and document markdown: code, math, links, GenUI fences, frontmatter.

`markdownPolicy`, `MarkdownPolicy`, `MarkdownTrust`, `MarkdownVariant`, `UnifiedMarkdown`, `UnifiedMarkdownProps`, `CopyOverlay`, `HighlightedCode`, `CopyButton`, `MarkdownWithFrontmatter`, `languageLabel`, `normalizeLanguage`

## `@kortix/ui/genui`

Source: `src/markdown/genui/index.ts`. Typed UI blocks inside assistant markdown: the block renderer, the component set, telemetry, copy-as-text.

`GenuiFenceBoundary`, `GenuiTelemetryContext`, `GenuiTelemetryScope`, `GenuiPending`, `genuiComponents`, `GenuiMessageBlock`, `GenuiBlock`, `copyGenuiText`, `genuiCopyText`, `mayHoldGenui`, `useGenuiCopyMessages`, `GenuiForceEnabledContext`, `useGenuiEnabled`

## `@kortix/ui/diff`

Source: `src/diff/index.ts`. One file diff (split or unified).

`DiffView`

## `@kortix/ui/changes`

Source: `src/changes/index.ts`. A file-by-file change list and its vocabulary.

`ChangeList`, `ChangeSummary`, `DiffLayoutToggle`, `ExpandAllButton`, `useChangeExpansion`, `CHANGE_KIND`, `DIFF_LAYOUT_LABEL`, `PROPOSED_CHANGE_STATE`, `changeKind`, `diffViewportClass`, `entryFromCommitFile`, `entryFromVcsFile`, `fileCount`, `initiallyExpanded`, `proposedChangeTimeline`, `shouldReseedExpansion`, `splitPath`, `splitUnifiedPatch`, `totalChanges`, `ChangeEntry`, `ChangeKind`, `ChangeTotals`, `DiffLayout`, `ProposedChangeStatus`

## `@kortix/ui/files`

Source: `src/files/index.ts`. Browse and edit files. Project files are the git-backed repo; sandbox files are a live session workspace.

Mount: Project files: inside `ProjectFilesProvider` (`projectId`, optional git `ref`). Sandbox files: inside a mounted `useSession`. `FilePreviewHost`: once, on a page with no session side panel; a file open (`openPreview`) shows there. `SessionThread` mounts it already.

`saveDriveFile`, `useDismissDriveConflict`, `useDriveAvailability`, `useDriveConflicts`, `useDriveFolder`, `useFolderAccess`, `useFolderPrincipals`, `useInvalidateDrives`, `useProjectDrive`, `useShareFolder`, `useUnshareFolder`, `FilesStoreProvider`, `getFileIcon`, `FilePreviewDialog`, `FilePreviewHost`, `ChangeRequestDetailDialog`, `DiffRenderer`, `DriveExplorer`, `FileExplorerPage`, `FileThumbnail`, `ProjectFilesProvider`, `useProjectContext`, `FileExplorerSourceProvider`, `ExplorerQueryResult`, `FileExplorerSource`, `gitRefExplorerSource`, `useChangeRequestRecovery`, `changeRequestKeys`, `openChangeRequestListQuery`, `useChangeRequestDiff`, `useChangeRequestMergePreview`, `useCloseChangeRequest`, `useMergeChangeRequest`, `useRequestChangesOnChangeRequest`, `useSelectedVersion`, `workspaceFileSource`, `useWorkspaceSearch`, `SandboxFileExplorer`

## `@kortix/ui/file-viewer`

Source: `src/files/viewer/index.ts`. Render any file kind (pdf, docx, xlsx, csv, pptx, zip, images, code) from a byte source.

Mount: Inside `FileSourceProvider` (where the bytes come from).

`FileContentRenderer`, `FileContentRendererProps`, `FilePreviewModal`, `FilePreviewModalProps`, `FilePreviewState`, `FileSourceProvider`, `useFileSource`, `BinaryBlobResult`, `FileContent`, `FileContentResult`, `FilePatch`, `FilePatchHunk`, `FileSource`, `HtmlPreview`, `PreviewFitProvider`, `isUsableIntrinsicSize`, `SaveAsPdfButton`, `framePolicy`, `getFileCategory`, `getLanguageFromExt`, `FileCategory`, `FrameContent`, `FramePolicy`, `FileViewer`, `ShowCarouselItem`

## `@kortix/ui/terminal`

Source: `src/terminal/index.ts`. The session terminal (one ambient shell per session).

Mount: Inside a mounted `useSession` (the PTY client comes from `@kortix/sdk/react`).

`SessionTerminal`, `shouldPaintFatalCard`, `shouldPaintTerminalCard`

## `@kortix/ui/browser`

Source: `src/browser/index.ts`. The sandbox browser tab.

Mount: Inside a mounted `useSession`.

`BrowserLanding`, `SessionBrowser`

## `@kortix/ui/apps`

Source: `src/apps/index.ts`. Live App frames, the frame pool and the App view model.

`AppPreview`, `AppPreviewOverlay`, `PREVIEW_SPINNER_DELAY_MS`, `PREVIEW_TILE_ASPECT`, `PREVIEW_VIEWPORT_HEIGHT`, `PREVIEW_VIEWPORT_WIDTH`, `framePlacement`, `previewScale`, `scheduleSlowPreview`, `ensureFrame`, `frameKey`, `framesKeepAlive`, `pruneFrames`, `reloadFrame`, `ANONYMOUS_MODES`, `DEPLOYMENT_COPY`, `appCan`, `appCommand`, `appHost`, `appStatus`, `appTabLabel`, `cardPreviewApp`, `childApps`, `deployNotice`, `gridApps`, `localizedAppCopy`, `isKortixAppUrl`

## `@kortix/ui/composer`

Source: `src/session/composer/index.ts`. The message composer: drop-in inputs, chrome, tiptap editor parts and the send pipeline.

Mount: Inside a mounted session (`ComposerChatInput` also works on a project home, before a session exists).

`ComposerAboveCard`, `ComposerCard`, `AgentSelector`, `agentDisplayLabel`, `captureAttachmentSubmission`, `runComposerSend`, `AttachmentSubmission`, `COMMAND_CHIP_ATTRIBUTE`, `COMMAND_CHIP_LABEL_ATTRIBUTE`, `COMMAND_CHIP_SELECTOR`, `COMMAND_CHIP_VALUE`, `draftWillRunCommand`, `planCommandAttachments`, `planUnresolvedCommandChip`, `readCommandChipLabel`, `COMPOSER_INPUT_SLOT_CLASS`, `COMPOSER_SHELL_CLASS`, `Composer`, `ComposerChatInput`, `ComposerOptions`, `ComposerDropZone`, `ComposerUnderbar`, `DraftScope`, `ComposerEditor`, `ComposerEditorHandle`, `baseExtensions`, `MentionNode`, `baseSuggestion`, `MenuController`, `ReasoningEffortSelector`, `SessionChatInput`, `SessionChatInputProps`, `useFirstPromptPreviewStore`, `useSessionComposerPrefillStore`, `createSubmitLatch`, `AttachedFile`

## `@kortix/ui/session`

Source: `src/session/index.ts`. The conversation: the drop-in thread, turns, tool rows, prompts, status, pickers, session operations.

Mount: Pass the `useSession(projectId, sessionId)` result: `<SessionThread session={session} />`. Importing the entry registers the built-in tool rows.

`SessionThread`, `SessionThreadProps`, `UserMessage`, `ThrottledMarkdown`, `UnifiedMarkdown`, `UnifiedMarkdownProps`, `ToolPartRenderer`, `ToolRegistry`, `BasicToolProps`, `ToolComponent`, `ToolProps`, `BasicTool`, `GenericTool`, `SessionChatInput`, `SessionChatInputProps`, `AgentSelector`, `ModelSelector`, `ModelSelectorProps`, `SessionPermissionPrompt`, `QuestionPrompt`, `QuestionPromptHandle`, `TurnErrorDisplay`, `SessionBusyIndicator`, `SessionStartingLoader`, `SessionStatus`, `UNTITLED_SESSION_LABEL`, `getSessionDisplayTitle`, `groupChangeRequestsBySession`, `hasSessionAwaitingTitle`, `isAwaitingTitle`, `projectSessionsRefetchInterval`, `resolveSessionListViewState`, `sessionLastActivityAt`, `sessionTitleHasLanded`, `shortRelative`, `sortSessionsByLastActivity`, `starterSectionOf`, `SessionDeleteModal`, `isLegacyMigratedSession`, `matchesSourceFilters`, `matchesStatusFilters`, `sessionDisplayLabel`, `sessionSource`, `SessionSourceFilter`, `useRenameSession`, `useSessionListActions`, `CompactModal`, `ProviderFailureRecovery`, `useModelConnectionGate`, `AgentPicker`, `ModelPicker`, `filterModels`, `ApprovalAgentContext`, `ApprovalDecisionActions`, `ApprovalParameters`, `approvalReviewable`, `useApprovalWaitingText`, `SessionApprovalNotice`, `createScopedSession`, `SandboxLoadingBoundary`, `SessionNoticeBanner`, `SessionConnectingBanner`, `ChatMinimap`, `SessionChat`, `SessionTurn`, `TranscriptTurnRow`, `TurnAssistantBlock`, `ToolSurfaceContext`, `partOutcome`, `ToolOutcomeContext`, `ToolOutputFallback`, `ServicePreviewActions`, `ServicePreviewState`, `ServicePreviewViewport`, `ToolActivateContext`, `TurnLiveContext`, `ActivityBurst`, `PlanCard`, `TurnViewport`, `ATTACHMENT_TILE_CAP`, `BUBBLE_SURFACE`, `ChannelOrigin`, `UserMessageBubble`, `mergeSentAttachments`, `normalizeAttachments`, `planAttachmentGrid`, `ChannelMessage`, `NormalizedAttachment`

## `@kortix/ui/session-panel`

Source: `src/session/panel/index.ts`. The session side panel: provider, panel bodies, files, changes and audit views, run read models.

Mount: Inside `SessionPanelProvider` (`sessionId`, `projectId`, `projectSessionId`).

`ActionPanel`, `AdvancedPanel`, `DiffDialog`, `EasyPanel`, `openSessionQuickView`, `SessionAudit`, `useSessionAudit`, `SessionFiles`, `SessionChanges`, `SessionPanelContext`, `SessionPanelProvider`, `useOptionalSessionPanel`, `SessionPanelValue`, `collectAllToolCalls`, `latestRunMessages`, `deriveRunOutcome`

## `@kortix/ui/workspace`

Source: `src/workspace/index.ts`. Composed project screens: session workspace, project sidebar, sessions list, project home, permission and route helpers.

Mount: `SessionWorkspace` takes `session` (the `useSession` result): the thread plus the resizable side panel. `children` replaces the thread. `SessionLayout` is the same layout with explicit ids (`sessionId` = runtime id, `projectId`, `projectSessionId`, `bootStage`, `transient`) and the thread as `children`. Project screens take `projectId`; `ProjectSessionList` mounts inside a `SidebarProvider`.

`ProjectPageHeader`, `useCapabilityAccess`, `useProjectNavRows`, `SidebarToggle`, `activeCapabilityTab`, `agentHref`, `capabilityTabHref`, `channelsHref`, `remindersHref`, `reviewHref`, `detectManifestVersion`, `manifestFilename`, `manifestNeedsUpgrade`, `useProjectManifestVersion`, `ManifestVersion`, `CUSTOMIZE_SECTION_ACCESS`, `CUSTOMIZE_SECTION_GATE_ACTIONS`, `PROJECT_ACTIONS`, `isCustomizeSectionVisible`, `CustomizeSection`, `ProjectAction`, `usePermission`, `usePermissions`, `usePermissionsFor`, `PROJECT_PAGE_ACTIONS`, `useProjectCan`, `useProjectCans`, `useProjectPageCans`, `CanResult`, `formatFireTime`, `nearestFire`, `reminderTitle`, `scheduleLabel`, `ProjectHomeWallpaper`, `ProjectHomeWelcomeBody`, `InstantSessionShell`, `ProjectFilesView`, `ProjectHome`, `SavedSessionSkeleton`, `SessionLayout`, `SessionWorkspace`, `SessionLayoutProps`, `SessionWorkspaceProps`, `ProjectSessionsView`, `ProjectSessionList`, `ProjectSidebar`

## `@kortix/ui/access`

Source: `src/access/index.ts`. Sharing and roles: access dialog, rows, role select, principal picker.

Mount: Takes the resource and its principals as props.

`AccessDialog`, `AccessRow`, `PrincipalPicker`, `RoleSelect`

## `@kortix/ui/customize`

Source: `src/customize/index.ts`. Project configuration pages: connectors, agents, triggers, secrets, models, skills, settings.

Mount: Each page takes `projectId`.

`AgentPage`, `AgentsPage`, `ConnectorsPage`, `ModelsPage`, `ProjectSettingsPage`, `SecretsPage`, `CapabilityPageShell`, `SkillsPage`, `TriggersPage`
