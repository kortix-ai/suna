/**
 * The web origin every "open on kortix.com" link uses (Jay, 2026-09-24).
 *
 * Always production kortix.com — never `EXPO_PUBLIC_FRONTEND_URL`, never a
 * value inferred from the backend URL. A dev build pointed at a local backend
 * used to open `http://localhost:3000/...` on the phone, where nothing runs.
 */
export const KORTIX_WEB_URL = 'https://kortix.com';
