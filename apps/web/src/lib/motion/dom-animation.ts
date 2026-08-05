// Dedicated module so `LazyMotion`'s dynamic `features` loader can split this
// off into its own chunk. `domAnimation` covers plain animations plus
// hover/tap/focus/viewport gestures and `AnimatePresence` exit animations —
// everything the app's `m.*` sites need except `layout`/`layoutId`/`drag`.
// Do NOT re-export `domMax` from this file: that would pull the drag+layout
// feature code into whatever chunk imports this one.
export { domAnimation } from 'motion/react';
