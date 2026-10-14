import { ThemedSurface } from '@/features/layout/themed-surface';
import { INTERFACE_THEME_INIT_SCRIPT } from '@/lib/interface-themes';

/** Interface themes apply here; see "Themed surface" in lib/interface-themes.ts. */
export default function ThemedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: INTERFACE_THEME_INIT_SCRIPT }} />
      <ThemedSurface />
      {children}
    </>
  );
}
