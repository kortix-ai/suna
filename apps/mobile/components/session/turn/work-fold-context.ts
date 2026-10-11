import { createContext } from 'react';

/**
 * True under an opened "Worked for" row (`WorkAccordion`). The row already
 * summarises the turn, so each burst under it drops its own "Completed N
 * steps" line and lists its steps (`ActivityBurst`). Mirrors apps/web
 * `turn/turn-work-accordion.tsx` `WorkFoldContext`.
 */
export const WorkFoldContext = createContext(false);
