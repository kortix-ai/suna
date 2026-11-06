/**
 * The session route's own boundary, one segment up, so it also covers
 * `[sessionId]/layout.tsx`.
 *
 * A segment's `loading.tsx` sits inside that segment's layout and never wraps
 * it. The session layout is an async server layout (the tab title), so while
 * its round-trip ran, the nearest boundary above it was the project's pulsing
 * Kortix mark: a blank page between the home composer and the instant session
 * shell (KRTX-2931). This renders `[sessionId]/loading.tsx` instead, which
 * paints the shell with the user's bubble from the first frame.
 *
 * `/projects/[id]/sessions` (no session id) gets the project mark, as before.
 */
export { default } from './[sessionId]/loading';
