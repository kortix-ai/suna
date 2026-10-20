// Its own module so UiProvider's `LazyMotion` loads the animation engine as a
// separate chunk (a dynamic import of 'motion/react' itself splits nothing).
export { domMax } from 'motion/react';
