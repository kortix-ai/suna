'use client';

import * as React from 'react';

/**
 * The host adapters for @kortix/ui: the copy components render when the
 * caller passes no label, and the link component they navigate with. A host
 * mounts <UiProvider> once at its root. Without one, components render the
 * English defaults and a plain <a>.
 */
export interface UiStrings {
  /** ConfirmDialog confirm button. */
  confirm: string;
  /** ConfirmDialog cancel button. */
  cancel: string;
  /** CommandDialog screen-reader title. */
  commandPaletteTitle: string;
  /** CommandDialog screen-reader description. */
  commandPaletteDescription: string;
}

export const defaultUiStrings: UiStrings = {
  confirm: 'Confirm',
  cancel: 'Cancel',
  commandPaletteTitle: 'Command Palette',
  commandPaletteDescription: 'Search for a command to run...',
};

export type UiLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  ref?: React.Ref<HTMLAnchorElement>;
};
export type UiLinkComponent = React.ComponentType<UiLinkProps>;

const DefaultLink = React.forwardRef<HTMLAnchorElement, UiLinkProps>(function DefaultLink(
  props,
  ref,
) {
  return <a ref={ref} {...props} />;
});

interface UiContextValue {
  strings: UiStrings;
  link: UiLinkComponent;
}

const UiContext = React.createContext<UiContextValue>({
  strings: defaultUiStrings,
  link: DefaultLink,
});

export function UiProvider({
  strings,
  link,
  children,
}: {
  strings?: Partial<UiStrings>;
  link?: UiLinkComponent;
  children: React.ReactNode;
}) {
  const value = React.useMemo<UiContextValue>(
    () => ({ strings: { ...defaultUiStrings, ...strings }, link: link ?? DefaultLink }),
    [strings, link],
  );
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUiStrings(): UiStrings {
  return React.useContext(UiContext).strings;
}

export function useUiLink(): UiLinkComponent {
  return React.useContext(UiContext).link;
}
