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
 * The copy of the @kortix/ui/session pickers (`ModelPicker`, `AgentPicker`).
 * Every key has an English default; a host passes the keys it translates as
 * `strings.chat`. The session thread reads the i18n catalog instead
 * (`UiProvider` `i18n`).
 */
export interface ChatStrings {
  /** Model picker trigger label. */
  model: string;
  defaultModel: string;
  searchModels: string;
  models: string;
  noModelsMatch: string;
  /** Agent picker trigger label. */
  agent: string;
  defaultAgent: string;
  /** The default agent's row: `name (default)`. */
  defaultAgentNamed: (name: string) => string;
}

export const defaultChatStrings: ChatStrings = {
  model: 'Model',
  defaultModel: 'Default model',
  searchModels: 'Search models…',
  models: 'Models',
  noModelsMatch: 'No models match.',
  agent: 'Agent',
  defaultAgent: 'Default agent',
  defaultAgentNamed: (name) => `${name} (default)`,
};

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
  /** @kortix/ui/chat picker copy. */
  chat: ChatStrings;
}

export const defaultUiStrings: UiStrings = {
  confirm: 'Confirm',
  cancel: 'Cancel',
  close: 'Close',
  commandPaletteTitle: 'Command Palette',
  commandPaletteDescription: 'Search for a command to run...',
  chat: defaultChatStrings,
};

/** What a host passes as `strings`: any subset, `chat` included. */
export type UiStringsInput = Partial<Omit<UiStrings, 'chat'>> & { chat?: Partial<ChatStrings> };

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
}

const browserRouter: UiRouter = {
  push: (href) => window.location.assign(href),
  replace: (href) => window.location.replace(href),
  prefetch: () => {},
  back: () => window.history.back(),
};

function subscribeLocation(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
}

const NO_PARAMS: UiRouteParams = {};

/**
 * Framework-free navigation: full page loads, `window.location` reads that
 * update on `popstate`. SSR renders an empty pathname and no search params.
 * ponytail: a direct `history.pushState` is not observed; a SPA host passes its router.
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
};

/** Values the host knows and the UI reads. Every field has a default. */
export interface UiHostConfig {
  /** Billing is on, so upgrade actions have a target. Default: false. */
  billingEnabled: boolean;
  /**
   * The backend serves the hosted app-connector catalog ("Easy connect").
   * False hides that catalog; custom connectors stay. Default: true.
   */
  connectorsEnabled: boolean;
  /** The deployment serves its own managed model lineup. Default: false. */
  managedModelsEnabled: boolean;
  /** The deployment's release version, for version-pinned CLI install commands. Default: none (latest). */
  deploymentVersion?: string;
}

export const defaultUiHostConfig: UiHostConfig = {
  billingEnabled: false,
  connectorsEnabled: true,
  managedModelsEnabled: false,
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
  /** The decorative background of an empty session. Without it, the plain surface. */
  Wallpaper?: React.ComponentType;
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
  children: React.ReactNode;
}) {
  const value = React.useMemo<UiContextValue>(
    () => ({
      strings: { ...defaultUiStrings, ...strings, chat: { ...defaultChatStrings, ...strings?.chat } },
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
    }),
    [strings, link, image, useBrand, navigation, i18n, useViewerId, useViewer, updateViewerMetadata, config, components],
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

/** The host's component slots. A missing slot means: hide the control. */
export function useUiComponents(): UiHostComponents {
  return React.useContext(UiContext).components;
}

/** The host's translation hooks, or null for the bundled catalog. Read by `@kortix/ui/i18n`. */
export function useUiI18nHost(): UiI18nHost | null {
  return React.useContext(UiContext).i18n;
}
