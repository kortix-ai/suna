/**
 * Who needs the mouse right now. The TUI leaves the mouse to the terminal by
 * default, so its own text selection and copy keep working. A region that is
 * clickable — the splash (Game of Life), the session tabs, the sidebar — asks
 * for it while it is on screen; when the last one lets go, the renderer goes
 * back to exactly what it was (on with `--mouse`, else off).
 *
 * One counter for the whole process: two regions that each saved and restored
 * `renderer.useMouse` on their own restored a stale value when they unmounted
 * in the other order.
 */

interface MouseHost {
  useMouse: boolean;
}

let demands = 0;
let before: boolean | null = null;

/** Ask for the mouse. Call the returned function to let go (idempotent). */
export function demandMouse(renderer: MouseHost): () => void {
  if (demands === 0) before = renderer.useMouse;
  demands += 1;
  if (!renderer.useMouse) renderer.useMouse = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    demands -= 1;
    if (demands === 0 && before !== null) {
      if (renderer.useMouse !== before) renderer.useMouse = before;
      before = null;
    }
  };
}

/** Test seam: forget every demand. */
export function resetMouseDemandForTest(): void {
  demands = 0;
  before = null;
}
