// Dedicated module so `LazyMotion`'s dynamic `features` loader (see
// components/lazy-motion-provider.tsx) can split this off into its own
// chunk instead of `import('motion/react')` directly, which would not split
// anything (the barrel is already imported statically elsewhere for `m`/
// `AnimatePresence`).
//
// This is the app-wide feature bundle — not `domAnimation`. Multiple `layout`
// sites exist across the app (general-tab.tsx,
// step-connectors.tsx, projects-page.tsx, review-center.tsx), and
// framer-motion's feature loading is a global registry
// (`setFeatureDefinitions`), not scoped per `LazyMotion` boundary — so a
// smaller `domAnimation` provider plus a narrower local `domMax` boundary
// around only the sites known to need it is unsound: once any `domMax`
// boundary in the tree mounts, layout/drag become available everywhere,
// making correctness depend on mount order. One global `domMax` boundary is
// the only deterministic design. The extra bytes only affect the size of
// this deferred chunk, not the initial JS payload.
export { domMax } from 'motion/react';
