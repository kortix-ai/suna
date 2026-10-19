// @kortix/ui root barrel: light core primitives only. Heavy components
// (charts, maps, grids, mermaid, emoji data) are reachable only through their
// own subpath export, e.g. '@kortix/ui/<name>'.
export { cn } from './lib/utils';
export { Button, buttonVariants, type ButtonProps } from './components/ui/button';
export {
  UiProvider,
  defaultUiStrings,
  useUiLink,
  useUiStrings,
  type UiLinkComponent,
  type UiLinkProps,
  type UiStrings,
} from './providers/ui-provider';
export { useIsDark } from './hooks/use-is-dark';
