---
name: kortix-ui
description: "Build React UI with @kortix/ui, the Kortix component library and the whole Kortix session experience as modules (session workspace, thread, composer, side panel, files, file viewer, terminal, project sidebar and home, customize pages): Kortix Apps, white-label hosts, custom dashboards on @kortix/sdk and apps/web. Load before you write a component, a page, a chat or session view, a custom dashboard or App, or a className in a React host that renders Kortix UI, or when you theme Kortix components for another brand. Covers setup, the module map, which component to compose, banned primitives, tokens, the dashboard guide, white-label theming and the verify steps."
---

# @kortix/ui

`@kortix/ui` is the one React component library for every Kortix surface: `apps/web`, Kortix Apps, the
white-label demo and SDK customer apps. Components are Tailwind v4 class strings that read CSS variables.
Docs: https://kortix.com/docs/sdk/ui. Live catalog: https://kortix.com/design-system.

Availability: a workspace package of `kortix-ai/suna` (`"@kortix/ui": "workspace:*"`), not on npm yet.
Outside it: tell the user, style with plain CSS over the section 6 variables, never copy component source.

## 1. Set up once

1. Styles. A Tailwind v4 host: `@import 'tailwindcss'; @import '@kortix/ui/tailwind.css';` in its main CSS,
   plus the optional peers `tw-animate-css`, `tailwind-scrollbar`, `tailwind-scrollbar-hide`.
   A host without Tailwind imports `@kortix/ui/styles.css` once: every class the package uses, none of yours.
2. Fonts. `@kortix/ui/fonts.css` (Roobert) is for Kortix-owned surfaces only. A white-label host never imports it.
3. Mount once at the root: `QueryClientProvider`, `UiProvider` (`link`, `navigation`: your router; `components`:
   host slots, a missing slot hides its control; `config`: `managedModelsEnabled`, `connectorsEnabled`, `terminalEnabled`, `commandPaletteShortcut`, `settingsShortcut`; `resolvePreviewUrl`; `useBrand`: your
   marks; `i18n`, `strings`, `image`, `useViewerId`: without it no sender name or "Stopped by" shows), `IconProvider` (`@kortix/ui/icon-provider`), one `<Toaster />`
   (`@kortix/ui/toast`). `setUiTelemetry` (`@kortix/ui`) once at module load. Dark mode is `dark` on `<html>`. SDK `billingEnabled` stays off (Kortix's app only).
4. Ids, never route params. `SessionThread`, `SessionWorkspace` and `ProjectHome` mount `SessionIdsProvider` and the
   SDK project scope themselves. A block outside them: `KortixProjectProvider` (`@kortix/sdk/react`) and
   `SessionIdsProvider` (`projectId`, `sessionId`) around it. Links follow `setUiRoutes` (`@kortix/ui`): map each page you do not serve to `null`.
5. Import by subpath: `import { Modal } from '@kortix/ui/modal'`. The root `@kortix/ui` (section 7) needs no `@kortix/sdk`.

## 2. Compose before you create

| Job | Compose | Subpath |
| --- | --- | --- |
| Dialog or sheet | `Modal`, `ModalContent`, `ModalHeader`, `ModalTitle`, `ModalBody`, `ModalFooter` | `modal` |
| Destructive action | `ConfirmDialog` before the mutation, never a single click | `confirm-dialog` |
| Tooltip on an icon button | `Hint label="…"` | `hint` |
| Toast after a mutation | `successToast`, `errorToast`, `infoToast`, `warningToast`, `loadingToast` | `toast` |
| Status chip; count beside a label | `Badge size="sm"`; `CountBadge` (`waiting`, `reminder`, `conflict`, `neutral`) | `badge`, `count-badge` |
| Inline alert | `InfoBanner tone="…" title="…"` | `info-banner` |
| Pending spinner | `Loading` (default export) | `loading` |
| Expand and collapse | `Disclosure`, `DisclosureTrigger`, `DisclosureContent` | `disclosure` |
| Form field; search field | `Field`, `FieldLabel`, `FieldGroup`, `FieldDescription` with `Input`, `Textarea`, `Select`; `InputGroupSearch` | `field`, `input-group` |
| Panel; buttons side by side | `Card` and its slots, or `bg-popover rounded-md border px-4 py-5`; `ButtonGroup` | `card`, `button-group` |
| Tabs and filters | `Tabs`, `TabsList`, `TabsListCompact` | `tabs` |
| Menu, picker, palette | `DropdownMenu`, `Popover`, `Command` | `dropdown-menu`, `popover`, `command` |
| Table and empty list | `Table`; `Empty` with one muted line | `table`, `empty` |

A new primitive is the last step: tokens only, a small API, and a section on `/design-system`.
## 3. Banned

| Never | Use |
| --- | --- |
| `Dialog` / `DialogContent` in feature code | `Modal` |
| `Tooltip` primitives in feature code | `Hint` |
| `toast()` from `sonner`, `toast.success()` | the toast helpers and `<Toaster />`, all from `@kortix/ui/toast`; a host needs no `sonner` import |
| An icon with `animate-spin`, `CircleNotchIcon`, `SpinnerIcon` | `Loading` |
| A hand-rolled chip `<span>` or a colored banner | `Badge`, `InfoBanner` |
| `SectionCard`, `List` / `ListRow` | `Card`, `<ul className="space-y-2">` rows |
| `lucide-react` or another icon set | `@phosphor-icons/react`, `*Icon` names, no `weight` prop (only `weight="fill"` for solid status glyphs) |
| A fork or a restyled copy of a component | the component as it ships; theme with tokens (section 6) |

## 4. Tokens only

- Colors are semantic utilities (`bg-background`, `bg-card`, `bg-muted`, `text-muted-foreground`, `border-border`,
  `bg-primary`, `text-destructive`). Never a hex, `rgb()`, `oklch()` or a palette class (`text-emerald-600`).
- `--spacing` is `0.23rem`, 8% tighter than stock Tailwind: a 16px mockup gap is `gap-4`, never `gap-[16px]`.
- `rounded-md` for panels and fields; elevation only on overlays. Hover is `transition-colors duration-fast`; no motion over 300 ms.

## 5. Status tones

One meaning per hue. `StatusTone` (`@kortix/ui/status`): `success`, `warning`, `destructive`, `info`, `neutral`, for
`InfoBanner tone`, `StatusBadge`, `STATUS_DOT`; `Badge` variants map the same, `muted` for neutral. Tinted icon tile:
`bg-kortix-green/15` (or `-orange`, `-blue`) with the icon in the full hue.

## 6. White-label

Theme with `@kortix/ui/theme`, never by forking a component: `themeToCss(theme)` in a `<style>` for the app,
`<ThemeScope theme>` for one subtree (its overlays portal into it). `KortixTheme` fields are all optional: `light` /
`dark` colors (`blue` accent, `ring` focus, `border`, `muted`, `foreground`, `background`, `primary`, any `--custom`),
`radius`, `borderWidth`, `fonts.sans` / `fonts.mono`, `spacing`, `text`, `lineHeights`, `shadows`, `durations`, `easing`,
`vars`. Pass the organization's marks to `UiProvider useBrand`. Every key, default and limit: `references/theming.md`.

## 7. Components

| Import from | Names |
| --- | --- |
| `@kortix/ui` (adapters) | `cn`, `UiProvider`, `defaultUiStrings`, `useUiStrings`, `useUiLink`, `useUiImage`, `useUiBrand`, `UiStrings`, `UiStringsInput`, `UiLinkProps`, `UiLinkComponent`, `UiImageProps`, `UiImageComponent`, `UiBrand`, `UseUiBrand`, `useIsDark`, `useUiRouter`, `useUiPathname`, `useUiSearchParams`, `useUiParams`, `defaultUiNavigation`, `UiNavigation`, `UiRouter`, `UiRouteParams`, `UiSearchParams`, `useUiViewerId`, `useUiHostConfig`, `defaultUiHostConfig`, `UiHostConfig`, `SessionIdsProvider`, `useSessionIds`, `UiSessionIds` |
| `@kortix/ui` (actions, display) | `Button`, `buttonVariants`, `ButtonProps`, `Badge`, `badgeVariants`, `Card`, `CardAction`, `CardButton`, `CardContent`, `CardDescription`, `CardEyebrow`, `CardFeature`, `CardFooter`, `CardGroup`, `CardHeader`, `CardImage`, `CardMedia`, `CardTitle`, `CardButtonProps`, `CardButtonSize`, `CardButtonVariant`, `CardGroupProps`, `CardLogo`, `CardProps`, `Separator`, `Skeleton` |
| `@kortix/ui` (forms) | `Input`, `inputFocusClasses`, `inputInvalidClasses`, `inputSurfaceClasses`, `inputTransitionClasses`, `InputProps`, `useAutosizeTextArea`, `Textarea`, `AutosizeTextAreaRef`, `AutosizeTextAreaProps`, `Label`, `Checkbox`, `CheckboxProps`, `CheckboxVariant`, `Switch`, `SwitchProps`, `Select`, `SelectContent`, `SelectGroup`, `SelectItem`, `SelectLabel`, `SelectScrollDownButton`, `SelectScrollUpButton`, `SelectSeparator`, `SelectTrigger`, `SelectValue`, `SelectTriggerProps` |
| `@kortix/ui` (overlays) | `Modal`, `ModalBody`, `ModalClose`, `ModalContent`, `ModalContentInner`, `ModalDescription`, `ModalFooter`, `ModalHeader`, `ModalOverlay`, `ModalPortal`, `ModalTitle`, `ModalTrigger`, `Hint`, `HintProps`, `Popover`, `PopoverAnchor`, `PopoverContent`, `PopoverTrigger`, `DropdownMenu`, `DropdownMenuCheckboxItem`, `DropdownMenuContent`, `DropdownMenuGroup`, `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuPortal`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuSub`, `DropdownMenuSubContent`, `DropdownMenuSubTrigger`, `DropdownMenuTrigger` |
| `@kortix/ui` (primitives, not for feature code: section 3) | `Dialog`, `DialogClose`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogOverlay`, `DialogPortal`, `DialogTitle`, `DialogTrigger`, `Tooltip`, `TooltipContent`, `TooltipProvider`, `TooltipTrigger` |
| `@kortix/ui` (navigation) | `FilterBar`, `FilterBarItem`, `Tabs`, `TabsContent`, `TabsList`, `TabsListCompact`, `TabsTrigger`, `TabsTriggerCompact`, `tabsTriggerHeightVariants`, `tabsTriggerPaddingVariants`, `tabsTriggerTextVariants`, `TabsListType`, `TabsSize`, `TabsTriggerSize`, `TabsTriggerVariant`, `TabsUnderlineSize` |
| `@kortix/ui` (conversation) | `Bubble`, `BubbleContent`, `BubbleGroup`, `BubbleReactions`, `bubbleVariants`, `Message`, `MessageAvatar`, `MessageContent`, `MessageFooter`, `MessageGroup`, `MessageHeader`, `Marker`, `MarkerContent`, `MarkerIcon`, `markerVariants` |
| `@kortix/ui` (hooks, helpers) | `UiLink`, `UiImage`, `useUiViewer`, `UiViewer`, `UiHostComponents`, `UiPreviewUrlResolver`, `UiPreviewRequest`, `useDebounce`, `useIsMobile`, `useMediaQuery`, `useSlashFocus`, `lazyClient`, `spring`, `floatingZ`, `dialogContentZ`, `dialogOverlayZ`, `useDialogDepth`, `hasOpenFloatingLayer`, `hasOpenNestedDialog`, `DEFAULT_ICON_WEIGHT`, `ICON_WEIGHTS`, `SHIPPED_ICON_WEIGHTS`, `faviconUrlForHostname`, `setUiTelemetry`, `setUiHostEnv`, `setUiRoutes`, `uiRoutes`, `defaultUiRoutes`, `UiRoutes` |
| `@kortix/ui/theme` | `KortixTheme`, `themeToCss`, `themeToCssVars`, `ThemeScope`, `ThemeScopeProps`, `THEME_COLOR_VARS`, `ThemeColor`, `ThemeColors`, `ThemeCssVars`, `ThemeTextStep`, `ThemeShadowStep`, `ThemeDurationStep`, `ThemeEasing`, `WALLPAPERS`, `DEFAULT_WALLPAPER_ID`, `getWallpaperById`, `Wallpaper` |
| `@kortix/ui/session` (whole thread) | `SessionThread`, `SessionThreadProps` |
| `@kortix/ui/session` (blocks) | `UserMessage`, `ThrottledMarkdown`, `UnifiedMarkdown`, `UnifiedMarkdownProps`, `ToolPartRenderer`, `SessionChatInput`, `SessionChatInputProps`, `AgentSelector`, `ModelSelector`, `ModelSelectorProps`, `SessionPermissionPrompt`, `QuestionPrompt`, `QuestionPromptHandle`, `TurnErrorDisplay`, `SessionBusyIndicator`, `SessionStartingLoader` |
| `@kortix/ui/session` (tool rows, pickers) | `ToolRegistry`, `ToolProps`, `ToolComponent`, `BasicTool`, `BasicToolProps`, `GenericTool`; for a form outside a session: `ModelSelector`, `AgentSelector` |


Every other primitive is one subpath per file: `@kortix/ui/<file name>` (`@kortix/ui/dot-matrix/<name>` for the dot matrices).
Also: `lib/telemetry` (`UiTelemetryRegister`: declaration-merge `event`), `error-boundary` (`ErrorBoundary`, `ErrorBoundaryFallback`).

## 8. Modules

One entry per module. Its curated names are the public API (semver). Every name, prop and a compiling example: `references/modules.md`.

| Entry | What it is | Minimal mount |
| --- | --- | --- |
| `@kortix/ui/workspace` | Project screens: `SessionWorkspace` (thread + side panel), `ProjectHome`, `ProjectSessionList`, `ProjectFilesView` | `<SessionWorkspace session={useSession(p, s)} />`; the list inside `SidebarProvider` |
| `@kortix/ui/session` | The conversation: `SessionThread`, turns, `ToolRegistry`, prompts, pickers | `<SessionThread session={useSession(p, s)} />` |
| `@kortix/ui/composer` | The composer, its chrome, the send pipeline | `<ComposerChatInput projectId onSend />` in the project scope |
| `@kortix/ui/session-panel` | The side panel: `ActionPanel`, `SessionFiles`, `SessionChanges`, `SessionAudit` | `SessionPanelProvider` (runtime `sessionId`, `projectId`, `projectSessionId`) |
| `@kortix/ui/files` | Project files (git repo), sandbox files, `FilePreviewHost` | `ProjectFilesView` (workspace); `<FilePreviewHost />` once on a page without a side panel |
| `@kortix/ui/file-viewer` | Any file kind: pdf, docx, xlsx, csv, pptx, zip, images, code | `<FileViewer content fileName />`; `FileContentRenderer` in `FileSourceProvider` |
| `@kortix/ui/terminal`, `@kortix/ui/browser` | The session shell; the sandbox browser | the runtime ids of a mounted `useSession` |
| `@kortix/ui/markdown`, `@kortix/ui/genui` | Markdown with code, math, links; GenUI blocks | `<UnifiedMarkdown content trust="agent" />` |
| `@kortix/ui/diff`, `@kortix/ui/changes` | One diff; a change list | `<DiffView before after />` |
| `@kortix/ui/apps` | App frames, the frame pool, the App view model | none |
| `@kortix/ui/access`, `@kortix/ui/customize` | Sharing and roles; project configuration pages | `<ConnectorsPage projectId />` |
| `@kortix/ui/theme`, `@kortix/ui/i18n`, `@kortix/ui/icons` | Theme; `useTranslations`, `useLocale` (next-intl signatures); glyphs | none |

Deep paths (`@kortix/ui/internal/*`, `@kortix/ui/<module>/<path>`) have no semver: only Kortix's own apps import them (`scripts/deep-exports.json`).

## 9. Recipes

```tsx
import { useSession } from '@kortix/sdk/react';
import { SessionWorkspace } from '@kortix/ui/workspace';
export function Session({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  return <SessionWorkspace session={useSession(projectId, sessionId)} />;
}
```

- The parent sets the height. Install `@tanstack/react-query`, `@openuidev/lang-core@0.3.1` and `zod` with it.
  `SessionThread` (`@kortix/ui/session`) is the thread alone; with no side panel, file and preview opens show in a dialog.
- A custom tool row: `ToolRegistry.register('<tool name>', Row)`; `Row` gets `ToolProps`, draws `BasicTool`.
- A whole dashboard or App (client, router adapters, sidebar, project home, session, files, theme, tool row, App
  sign-in): `references/custom-dashboard.md`. Never a raw `fetch`: the SDK has the call, or gets it.

## 10. Verify

1. `tsc --noEmit` adds no error. Run the page in light and dark, at 720 × 480 and a phone width; click every control.
2. Your diff has no hex, `rgb(`, `-[` spacing bracket, `lucide-react`, `toast(` or `animate-spin`. Kortix-internal:
   `.agents/skills/kortix-brand/scripts/audit.sh <paths>` is clean. White-label: a new `--kortix-blue` reaches a checked `Switch`.

## 11. Kortix-internal work

In `kortix-ai/suna`, `kortix-brand` (values, voice) and `kortix-design-system` (which component) in `.agents/skills/` win
over this file. `apps/web` imports `@kortix/ui` like any host and keeps no re-export shims: edit the component in `packages/ui/src/`.
