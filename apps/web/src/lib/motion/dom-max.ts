// Dedicated module so `LazyMotion`'s dynamic `features` loader can split this
// off into its own chunk, separate from `dom-animation.ts`. `domMax` adds the
// `layout`/`layoutId`/`drag` projection engine on top of `domAnimation`. Only
// import this where a `layout` prop, `layoutId`, or `drag` is actually in use
// (currently: features/review-center/review-center.tsx) — everywhere else
// should use the smaller `dom-animation.ts` bundle.
export { domMax } from 'motion/react';
