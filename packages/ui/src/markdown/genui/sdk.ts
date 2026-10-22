/**
 * The one apps/web import of `@kortix/sdk/genui/react`. It loads `@openuidev/*`
 * and `zod`, so it lives only in this feature, which `markdown-code.tsx` reaches
 * through `lazy()`: the weight stays out of the main bundle. Listed in
 * CANONICAL_SDK_ENTRIES (`scripts/sdk-boundary.mjs`).
 */
// eslint-disable-next-line no-restricted-imports -- the generative UI renderer, loaded only in this lazy feature
import { GenuiBlock, type GenuiBlockEvent, type GenuiComponentMap, type GenuiComponentProps } from '@kortix/sdk/genui/react';

export { GenuiBlock };
export type { GenuiBlockEvent, GenuiComponentMap, GenuiComponentProps };
export type GenuiNode = GenuiComponentProps['node'];
