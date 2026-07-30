// Single source of truth for the static-fixture server. playwright.config.ts
// starts the server on this port; specs read the origin from here so the two
// can never drift.
export const FIXTURE_PORT = 8842;
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
