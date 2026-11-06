'use client';

import { createContext } from 'react';

/**
 * False: the composers under it do not take the focus when they mount. A
 * space's chat opens the thread a message just started beside it (flag
 * `chat`), while the person goes on typing in the chat: the thread's reply
 * box must not take the focus away. An explicit `autoFocus` prop still wins.
 */
export const ComposerAutoFocusContext = createContext<boolean>(true);
