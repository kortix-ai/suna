'use client';

import { useState } from 'react';

/**
 * True from the first render where `open` is true, and forever after.
 *
 * Gate for a `next/dynamic` dialog body: the chunk is not fetched while the
 * dialog was never opened, and the body stays mounted after the first open so
 * its close animation and internal state behave as before.
 */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}
