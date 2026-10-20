'use client';

import { useUiComponents } from '../../providers/ui-provider';

export function SessionWelcome() {
  const { Wallpaper } = useUiComponents();
  return (
    <div className="relative h-full w-full overflow-hidden">{Wallpaper ? <Wallpaper /> : null}</div>
  );
}
