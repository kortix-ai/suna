'use client';

import { LazyMotion } from 'motion/react';
import * as React from 'react';

import type { ProjectSession } from '@kortix/sdk';

import type { AbstractIntlMessages, useTranslations as useIntlTranslations } from 'use-intl';

/** What a host passes as `<UiProvider i18n>`. Pass a stable object. */
export interface UiI18nHost {
  /** The host's translation hook (use-intl's or next-intl's `useTranslations`). Wins over `messages`. */
  useTranslations?: typeof useIntlTranslations;
  /** The host's locale hook. Wins over `locale`. */
  useLocale?: () => string;
  /** Default: 'en'. */
  locale?: string;
  /** Default: the bundled English catalog. */
  messages?: AbstractIntlMessages;
}

/**
 * The host adapters for @kortix/ui: the copy components render when the
 * caller passes no label, the link component they navigate with, the
 * organization marks KortixLogo renders, the image and router components, translations, the viewer
 * and host flags. A host mounts <UiProvider> once at its root. Without one,
 * components render the English defaults, a plain <a>, the Kortix logo and
 * navigate with `window.location`. `components` fills the slots for app
 * features the UI renders whole (`UiHostComponents`); a missing slot hides
 * its control. Telemetry and deployment values are module-level:
 * `setUiTelemetry` in `@kortix/ui/lib/telemetry`, `setUiHostEnv` in
 * `@kortix/ui/lib/host-env`.
 */
/**
 * Every string @kortix/ui renders by itself. Components that render copy
 * without a caller-supplied label read it from here, so a host translates
 * them once through `<UiProvider strings>`. Copy not listed here is English
 * only (MermaidRenderer's controls).
 */
export interface UiStrings {
  /** ConfirmDialog confirm button. */
  confirm: string;
  /** ConfirmDialog and TypeToConfirmDialog cancel button. */
  cancel: string;
  /** Screen-reader label of the Dialog and Sheet close button. */
  close: string;
  /** CommandDialog screen-reader title. */
  commandPaletteTitle: string;
  /** CommandDialog screen-reader description. */
  commandPaletteDescription: string;
}

export const defaultUiStrings: UiStrings = {
  confirm: 'Confirm',
  cancel: 'Cancel',
  close: 'Close',
  commandPaletteTitle: 'Command Palette',
  commandPaletteDescription: 'Search for a command to run...',
};

/** What a host passes as `strings`: any subset. */
export type UiStringsInput = Partial<UiStrings>;

export type UiLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  ref?: React.Ref<HTMLAnchorElement>;
  /**
   * Router prefetch hint, as `next/link` reads it: `null` (default) = automatic,
   * `true` = the full page, `false` = none. The default link ignores it.
   */
  prefetch?: boolean | null;
};
export type UiLinkComponent = React.ComponentType<UiLinkProps>;

export type UiImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'width' | 'height'> & {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  /** Skip the host's image optimizer (`next/image` reads it). The default image ignores it. */
  unoptimized?: boolean;
  /** Fill the positioned parent, as `next/image` `fill` does. The default image sets the same inline styles. */
  fill?: boolean;
  /** Load first, as `next/image` `priority` does. The default image loads eagerly. */
  priority?: boolean;
};
export type UiImageComponent = React.ComponentType<UiImageProps>;

/** Organization marks that replace the Kortix logo. Each `*_dark_url` falls back to its light mark. */
export interface UiBrand {
  /** Alt text of the replaced logo. */
  app_name?: string | null;
  /** Wide brandmark: replaces the `brandmark` logo variant. */
  logo_url?: string | null;
  /** Square symbol: replaces the `icon` logo variant. */
  icon_url?: string | null;
  logo_dark_url?: string | null;
  icon_dark_url?: string | null;
}

/**
 * A hook that returns the brand for the subtree it is called in. KortixLogo
 * calls it on every render, so the host can read its own context (apps/web
 * passes `useBranding`). It must call the same hooks on every render.
 */
export type UseUiBrand = () => UiBrand | null;

const useNoBrand: UseUiBrand = () => null;

const DefaultLink = React.forwardRef<HTMLAnchorElement, UiLinkProps>(function DefaultLink(
  props,
  ref,
) {
  const { prefetch: _prefetch, ...anchor } = props;
  return <a ref={ref} {...anchor} />;
});

const FILL_STYLE: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };

function DefaultImage({ unoptimized: _unoptimized, fill, priority, alt, style, ...props }: UiImageProps) {
  return (
    <img
      {...props}
      alt={alt}
      loading={priority ? 'eager' : props.loading}
      style={fill ? { ...FILL_STYLE, ...style } : style}
    />
  );
}

/** Options of one navigation, as `next/navigation`'s router reads them. */
export interface UiNavigateOptions {
  /** False: keep the scroll position. Default: scroll to the top. The default router ignores it. */
  scroll?: boolean;
}

/** Client-side navigation. `next/navigation`'s `useRouter()` result fits as is. */
export interface UiRouter {
  push(href: string, options?: UiNavigateOptions): void;
  replace(href: string, options?: UiNavigateOptions): void;
  prefetch(href: string): void;
  back(): void;
}

/** Route segment values, as `next/navigation`'s `useParams()` returns them. */
export type UiRouteParams = Record<string, string | string[] | undefined>;

/** Read only: a Next.js host returns ReadonlyURLSearchParams, whose setters throw. Copy to change. */
export type UiSearchParams = URLSearchParams;

/**
 * The host router as four hooks, so a component calls only the one it reads.
 * Next.js hosts pass `next/navigation`'s hooks unchanged: one combined hook
 * would call `useSearchParams` everywhere and change what prerenders.
 */
export interface UiNavigation {
  useRouter: () => UiRouter;
  usePathname: () => string;
  useSearchParams: () => UiSearchParams;
  /** Default: no route params. A host with dynamic segments passes its own. */
  useParams: () => UiRouteParams;
  /**
   * The router observes `history.pushState` / `replaceState` (Next.js does,
   * React Router does not). True: a URL for the view already on screen (a
   * session tab, a query param) is written to history, with no navigation.
   * False or omitted: it goes through `useRouter`. The default navigation is true.
   */
  observesHistory?: boolean;
}

const browserRouter: UiRouter = {
  push: (href) => window.location.assign(href),
  replace: (href) => window.location.replace(href),
  prefetch: () => {},
  back: () => window.history.back(),
};

/** Dispatched after the UI writes history itself, so the default navigation re-reads the URL. */
const LOCATION_EVENT = 'kortix-ui:location';

function subscribeLocation(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(LOCATION_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(LOCATION_EVENT, onChange);
  };
}

const NO_PARAMS: UiRouteParams = {};

/**
 * Framework-free navigation: full page loads, `window.location` reads that
 * update on `popstate` and on the UI's own history writes
 * (`useUiShallowNavigate`). SSR renders an empty pathname and no search params.
 */
export const defaultUiNavigation: UiNavigation = {
  useRouter: () => browserRouter,
  usePathname: () =>
    React.useSyncExternalStore(subscribeLocation, () => window.location.pathname, () => ''),
  useSearchParams: () => {
    const search = React.useSyncExternalStore(
      subscribeLocation,
      () => window.location.search,
      () => '',
    );
    return React.useMemo(() => new URLSearchParams(search), [search]);
  },
  useParams: () => NO_PARAMS,
  observesHistory: true,
};

/** Values the host knows and the UI reads. Every field has a default. */
export interface UiHostConfig {
  /**
   * The backend serves the hosted app-connector catalog ("Easy connect").
   * False hides that catalog; custom connectors stay. Default: true.
   */
  connectorsEnabled: boolean;
  /** The deployment serves its own managed model lineup. Default: false. */
  managedModelsEnabled: boolean;
  /** The deployment's release version, for version-pinned CLI install commands. Default: none (latest). */
  deploymentVersion?: string;
  /**
   * The session terminal can connect: the host reaches the runtime's pty
   * WebSocket. A host that proxies HTTP only (a Next route handler cannot
   * upgrade a WebSocket) sets false, and the Terminal control is hidden. Default: true.
   */
  terminalEnabled: boolean;
  /**
   * The Terminal panel offers "Connect from your machine": the deployment's
   * CLI installer (`<origin>/install`) and `kortix sessions shell`. A host
   * that serves no installer and ships no Kortix CLI sets false, and the bar
   * is hidden. Default: true.
   */
  cliConnectEnabled: boolean;
  /**
   * The host serves the public share page at `share.public_path`
   * (`/share/session/<token>` on its own origin). False hides every control
   * that mints or lists a public link: the Share dialog's public-link section,
   * the Browser panel's Copy link and Manage links, and the file and app
   * viewers' Copy link. Default: true.
   */
  publicSharesEnabled: boolean;
  /**
   * Where the host serves the provider icons (`<base>/<icon>.svg`, apps/web: `/provider-icons`).
   * Default: none, so provider logos load from models.dev. The `kortix` provider draws `useBrand`'s icon.
   */
  providerIconBaseUrl?: string;
  /** The host opens a command palette on ⌘K / Ctrl+K; the composer hints at it. Default: false. */
  commandPaletteShortcut: boolean;
  /** The host opens settings on ⌘, / Ctrl+,; the composer hints at it. Default: false. */
  settingsShortcut: boolean;
  /**
   * The host reaches the backend's account routes: the IAM permission probes
   * (`/accounts/:id/iam/*`), account members and groups, billing (`/billing/*`)
   * and session oversight. A host that fronts one operator key and blocks those
   * routes sets false. Then no such request runs, the sharing pickers offer no
   * "Specific people" option, billing state stays empty (no balance warning, no
   * upgrade prompt), and every permission gate shows its control: the server
   * still enforces each route. Default: true.
   */
  accountApiEnabled: boolean;
  /**
   * The composer shows the model picker and the reasoning-effort picker. A
   * host that runs one model for its users sets false: the session runs its
   * resolved default model. Default: true.
   */
  modelPickerEnabled: boolean;
  /** The composer shows the context-usage ring (and its route to the context modal). Default: true. */
  contextMeterEnabled: boolean;
  /**
   * The composer shows the session-overrides gear (sandbox, secrets,
   * connectors, provider keys, folders). A host whose users never see the
   * infrastructure behind a session sets false. Default: true.
   */
  sessionOverridesEnabled: boolean;
  /**
   * The agents the composer's agent picker offers, by name. Unset: every
   * selectable agent. A host that installs its own agents beside the
   * project's defaults lists its own here.
   */
  offeredAgents?: readonly string[];
  /** Display names by agent name, for the agent picker. Unset or missing: the title-cased name. */
  agentLabels?: Readonly<Record<string, string>>;
  /**
   * A host that keeps files in its own store takes the composer's files here:
   * the attach button, a drop and a pasted file. The composer then uploads
   * none of them to the session's attachment store and shows no tray for
   * them. Unset: they upload as prompt attachments.
   */
  takeFiles?: (files: File[]) => void;
  /** The attach picker's `accept` list. Unset: images, PDF, text and code files. */
  attachAccept?: string;
  /**
   * The composer's `/` menu lists the session runtime's skills and commands,
   * and the Compact session action. A host that hides the harness from its
   * users sets false. Default: true.
   */
  runtimeSlashEnabled: boolean;
  /**
   * Rows the host adds to the composer's `/` menu, under their own headings.
   * A hook, so it may read the host's own data. Unset: none.
   */
  useSlashActions?: () => readonly UiSlashAction[];
}

/**
 * A row the host adds to the composer's `/` menu. Selecting it deletes the
 * `/` text and calls `onSelect`. When `onSelect` returns `{ insertText }`,
 * the composer inserts that text at the caret.
 */
export interface UiSlashAction {
  id: string;
  label: string;
  description: string;
  /** The heading the row sits under, for example "Workflows". */
  group: string;
  onSelect: () => void | { insertText: string };
}

/** What the session browser frames: a port and path inside the session's sandbox, or a URL. */
export interface UiPreviewRequest {
  projectId: string;
  sessionId: string;
  /** The sandbox port, or 0 for a URL outside the sandbox. */
  port: number;
  path: string;
  /** The address the user sees, for example `http://localhost:8123/`. */
  url: string;
}

/**
 * Resolves the final URL the session browser frames and opens in a new tab
 * (and the tab a sandbox link in a message or tool card opens),
 * with its own scoped credentials. Return null to use the default (the SDK's
 * preview URL with the SDK token). A host whose browser must not hold a Kortix
 * token, or whose origin is not the Kortix backend, resolves it on its server.
 */
export type UiPreviewUrlResolver = (request: UiPreviewRequest) => Promise<string | null>;

export const defaultUiHostConfig: UiHostConfig = {
  connectorsEnabled: true,
  managedModelsEnabled: false,
  terminalEnabled: true,
  cliConnectEnabled: true,
  publicSharesEnabled: true,
  commandPaletteShortcut: false,
  settingsShortcut: false,
  accountApiEnabled: true,
  modelPickerEnabled: true,
  contextMeterEnabled: true,
  sessionOverridesEnabled: true,
  runtimeSlashEnabled: true,
};

const useNoViewer = (): string | undefined => undefined;

/** The signed-in user, as the host's auth knows them. */
export interface UiViewer {
  id: string;
  email?: string | null;
  /**
   * Profile fields of the host's auth user. The UI reads `name`, `full_name`
   * and `avatar_url` (strings) for greetings, avatars and labels.
   */
  metadata?: Readonly<Record<string, unknown>>;
}

/** A viewer hook built from an id hook: `{ id }`, stable per id. */
function viewerFromId(useId: () => string | undefined): () => UiViewer | undefined {
  return function useViewerFromId() {
    const id = useId();
    return React.useMemo(() => (id ? { id } : undefined), [id]);
  };
}

const useNoViewerProfile = (): UiViewer | undefined => undefined;

/** An id hook built from a viewer hook. */
function idFromViewer(useViewer: () => UiViewer | undefined): () => string | undefined {
  return function useIdFromViewer() {
    return useViewer()?.id;
  };
}

/** Merges `patch` into the signed-in user's `metadata` and resolves once it is saved. */
export type UpdateUiViewerMetadata = (patch: Record<string, unknown>) => Promise<void>;

/**
 * App features the UI renders whole but does not own. Every slot is
 * optional: without it, the UI hides the control that opens it.
 */
export interface UiHostComponents {
  /**
   * Lists, connects and removes the viewer's own accounts for one pooled
   * provider in a project. Without it, the "connect your account" controls are hidden.
   */
  ProviderAccountsModal?: React.ComponentType<{
    projectId: string;
    /** The pooled provider, for example `'codex'`. */
    providerId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }>;
  /** Connects the app a connector setup link names. Without it, the connector card is hidden. */
  ConnectorConnectModal?: React.ComponentType<{
    /** The setup link token. */
    token: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConnected: () => void;
    /** The app name to show until the link info loads. */
    fallbackName: string;
  }>;
  /**
   * Connects model providers and picks a project's models. Without it, the
   * "connect a model" controls are hidden.
   */
  ProjectProviderModal?: React.ComponentType<{
    projectId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    defaultTab?: 'providers' | 'models';
    /** False or missing: read only. */
    canWrite?: boolean;
  }>;
  /**
   * The full artifact viewer (doc editor, history, share, PDF export) for a
   * session panel. Without it, the panel shows the artifact's page read-only.
   */
  ArtifactViewer?: React.ComponentType<{ projectId: string; artifactId: string; onClose: () => void }>;
  /** The decorative background of an empty session. Without it, the plain surface. */
  Wallpaper?: React.ComponentType;
  /**
   * The host's own announcement on the project home, once onboarding is done
   * (apps/web: its mobile app). Without it, nothing is shown.
   */
  HomeAnnouncement?: React.ComponentType;
  /**
   * One room's conversation (flag `agent_rooms`): its messages and a composer,
   * by room NAME. A room that does not exist yet shows an empty state, and the
   * first post creates it with `emptyTopic`. A space page renders its own room
   * (the room named like the space's slug) through it, `fill` in its room
   * tab: no frame, no header, the container's full height. Without it, a link
   * to the rooms page.
   */
  RoomPanel?: React.ComponentType<{
    projectId: string;
    roomName: string;
    emptyTopic?: string;
    fill?: boolean;
    /** Replaces the room's one-line intro above its first message (the space page's room tab). */
    intro?: React.ReactNode;
  }>;
  /** Who can open a session, and its public link. Without it, the header has no Share button. */
  ShareSessionModal?: React.ComponentType<{
    projectId: string;
    session: ProjectSession | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved?: () => void;
  }>;
}

const NO_COMPONENTS: UiHostComponents = {};

interface UiContextValue {
  strings: UiStrings;
  link: UiLinkComponent;
  image: UiImageComponent;
  useBrand: UseUiBrand;
  navigation: UiNavigation;
  i18n: UiI18nHost | null;
  useViewerId: () => string | undefined;
  useViewer: () => UiViewer | undefined;
  updateViewerMetadata: UpdateUiViewerMetadata | undefined;
  config: UiHostConfig;
  components: UiHostComponents;
  resolvePreviewUrl: UiPreviewUrlResolver | undefined;
}

const UiContext = React.createContext<UiContextValue>({
  strings: defaultUiStrings,
  link: DefaultLink,
  image: DefaultImage,
  useBrand: useNoBrand,
  navigation: defaultUiNavigation,
  i18n: null,
  useViewerId: useNoViewer,
  useViewer: useNoViewerProfile,
  updateViewerMetadata: undefined,
  config: defaultUiHostConfig,
  components: NO_COMPONENTS,
  resolvePreviewUrl: undefined,
});

export function UiProvider({
  strings,
  link,
  image,
  useBrand,
  navigation,
  i18n,
  useViewerId,
  useViewer,
  updateViewerMetadata,
  config,
  components,
  resolvePreviewUrl,
  children,
}: {
  strings?: UiStringsInput;
  link?: UiLinkComponent;
  /** Default: a plain <img>. apps/web passes `next/image`. */
  image?: UiImageComponent;
  /** Default: no brand, so KortixLogo renders the Kortix marks. */
  useBrand?: UseUiBrand;
  /** Default: `defaultUiNavigation`. Pass a stable object. */
  navigation?: UiNavigation;
  /** Default: the bundled English catalog (`@kortix/ui/i18n`). Pass a stable object. */
  i18n?: UiI18nHost;
  /** A hook that returns the signed-in user's id. Default: `useViewer`'s id, else no viewer. */
  useViewerId?: () => string | undefined;
  /**
   * A hook that returns the signed-in user, stable while they do not change.
   * Default: `{ id }` from `useViewerId`, else no viewer.
   */
  useViewer?: () => UiViewer | undefined;
  /**
   * Saves profile fields on the signed-in user (UI preferences that follow
   * them across devices). Default: none, so those preferences stay in this browser.
   */
  updateViewerMetadata?: UpdateUiViewerMetadata;
  config?: Partial<UiHostConfig>;
  /** Default: no slots. Pass a stable object. */
  components?: UiHostComponents;
  /** Default: the SDK's preview URL. Pass a stable function. */
  resolvePreviewUrl?: UiPreviewUrlResolver;
  children: React.ReactNode;
}) {
  const value = React.useMemo<UiContextValue>(
    () => ({
      strings: { ...defaultUiStrings, ...strings },
      link: link ?? DefaultLink,
      image: image ?? DefaultImage,
      useBrand: useBrand ?? useNoBrand,
      navigation: navigation ?? defaultUiNavigation,
      i18n: i18n ?? null,
      useViewerId: useViewerId ?? (useViewer ? idFromViewer(useViewer) : useNoViewer),
      useViewer: useViewer ?? (useViewerId ? viewerFromId(useViewerId) : useNoViewerProfile),
      updateViewerMetadata,
      config: { ...defaultUiHostConfig, ...config },
      components: components ?? NO_COMPONENTS,
      resolvePreviewUrl,
    }),
    [
      strings,
      link,
      image,
      useBrand,
      navigation,
      i18n,
      useViewerId,
      useViewer,
      updateViewerMetadata,
      config,
      components,
      resolvePreviewUrl,
    ],
  );
  return (
    <UiContext.Provider value={value}>
      {/* The components animate with `m.*`, which does nothing outside a LazyMotion boundary. */}
      <LazyMotion features={loadMotionFeatures}>{children}</LazyMotion>
    </UiContext.Provider>
  );
}

const loadMotionFeatures = () => import('./motion-features').then((mod) => mod.domMax);

export function useUiStrings(): UiStrings {
  return React.useContext(UiContext).strings;
}

export function useUiLink(): UiLinkComponent {
  return React.useContext(UiContext).link;
}

export function useUiImage(): UiImageComponent {
  return React.useContext(UiContext).image;
}

/**
 * The host link as a component, for modules with many link sites:
 * `import { UiLink as Link }` reads like `next/link` and renders the
 * host's link (`next/link` in apps/web, a plain <a> without a host).
 */
export const UiLink = React.forwardRef<HTMLAnchorElement, Omit<UiLinkProps, 'ref'>>(function UiLink(
  props,
  ref,
) {
  const Link = useUiLink();
  return <Link ref={ref} {...props} />;
});

/** The host image as a component (`next/image` in apps/web, a plain <img> without a host). */
export function UiImage(props: UiImageProps) {
  const Image = useUiImage();
  return <Image {...props} alt={props.alt} />;
}

/** The host's organization brand for this subtree, or null for the Kortix marks. */
export function useUiBrand(): UiBrand | null {
  return React.useContext(UiContext).useBrand();
}

export function useUiRouter(): UiRouter {
  return React.useContext(UiContext).navigation.useRouter();
}

/** Moves the URL to a view the page already renders (a tab, a query param). */
export type UiShallowNavigate = (href: string, options?: { replace?: boolean }) => void;

/**
 * The URL change for a view already on screen: `history` when the host router
 * observes it (`UiNavigation.observesHistory`), else the host router, so a SPA
 * router never falls out of step with the address bar.
 */
export function useUiShallowNavigate(): UiShallowNavigate {
  const { navigation } = React.useContext(UiContext);
  const router = navigation.useRouter();
  const observesHistory = navigation.observesHistory === true;
  return React.useCallback(
    (href, options) => {
      if (!observesHistory) {
        if (options?.replace) router.replace(href, { scroll: false });
        else router.push(href, { scroll: false });
        return;
      }
      if (options?.replace) window.history.replaceState(null, '', href);
      else window.history.pushState(null, '', href);
      window.dispatchEvent(new window.Event(LOCATION_EVENT));
    },
    [observesHistory, router],
  );
}

export function useUiPathname(): string {
  return React.useContext(UiContext).navigation.usePathname();
}

export function useUiSearchParams(): UiSearchParams {
  return React.useContext(UiContext).navigation.useSearchParams();
}

/** The current route's dynamic segments. `T` narrows them, as `useParams<T>()` does. */
export function useUiParams<T extends UiRouteParams = UiRouteParams>(): T {
  return React.useContext(UiContext).navigation.useParams() as T;
}

/** The signed-in user's id, or undefined. */
export function useUiViewerId(): string | undefined {
  return React.useContext(UiContext).useViewerId();
}

/** The signed-in user, or undefined. */
export function useUiViewer(): UiViewer | undefined {
  return React.useContext(UiContext).useViewer();
}

/** The host's profile writer, or undefined: keep the preference local. */
export function useUiUpdateViewerMetadata(): UpdateUiViewerMetadata | undefined {
  return React.useContext(UiContext).updateViewerMetadata;
}

export function useUiHostConfig(): UiHostConfig {
  return React.useContext(UiContext).config;
}

/** The host's preview URL resolver, or undefined for the SDK default. */
export function useUiPreviewUrlResolver(): UiPreviewUrlResolver | undefined {
  return React.useContext(UiContext).resolvePreviewUrl;
}

/** The host's component slots. A missing slot means: hide the control. */
export function useUiComponents(): UiHostComponents {
  return React.useContext(UiContext).components;
}

/** The host's translation hooks, or null for the bundled catalog. Read by `@kortix/ui/i18n`. */
export function useUiI18nHost(): UiI18nHost | null {
  return React.useContext(UiContext).i18n;
}
