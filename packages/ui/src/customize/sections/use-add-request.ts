import { useEffect, useState } from 'react';

/**
 * Open "Add account" once per request from outside the list (a header button,
 * or the connector page right after Install). A request made before the list
 * mounted still opens it. The caller resets the request (`onHandled`), so a
 * remount on a tab switch does not open it again.
 *
 * The dialog opens during the render (this list's own state). The caller's
 * reset is the caller's state, so it runs after the render: React refuses a
 * parent update made while a child renders.
 */
export function useAddRequest(addRequest: number, open: () => void, onHandled?: () => void) {
  const [seen, setSeen] = useState(0);
  if (addRequest !== seen) {
    setSeen(addRequest);
    if (addRequest > 0) open();
  }
  useEffect(() => {
    if (addRequest > 0 && addRequest === seen) onHandled?.();
  }, [addRequest, seen, onHandled]);
}
