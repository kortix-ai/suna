import type { Icon as MynauiIcon, MynaIconsProps } from '@mynaui/icons-react';
import { mynauiIconRegistry, resolveIconKey } from '@/lib/utils/icon-utils';

/**
 * Drop-in replacement for `lucide-react/dynamic`'s `DynamicIcon`, backed by
 * `@mynaui/icons-react` Solid icons. Renders the icon whose runtime name string
 * (kebab- or PascalCase, lucide- or mynaui-vocabulary) resolves via
 * {@link resolveIconKey}. Falls back to `fallback` (or renders nothing) when the
 * name is unknown.
 */
export type DynamicIconProps = MynaIconsProps & {
  name: string;
  fallback?: MynauiIcon;
};

export function DynamicIcon({ name, fallback: Fallback, ...props }: DynamicIconProps) {
  const key = resolveIconKey(name);
  const Resolved = key ? mynauiIconRegistry[key] : undefined;
  const Component = Resolved ?? Fallback;
  if (!Component) return null;
  return <Component {...props} />;
}

export default DynamicIcon;
