'use client';

import { WallpaperBackground } from '@/components/ui/wallpaper-background';

/**
 * Empty-state backdrop — shows the user's selected wallpaper, full height.
 * The parent renders the chat input on top.
 */
export function SessionWelcome() {
  return (
    <div className="relative w-full h-full overflow-hidden">
      <WallpaperBackground />
    </div>
  );
}
