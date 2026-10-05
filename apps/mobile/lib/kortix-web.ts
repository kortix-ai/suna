/**
 * The web origin every "open on the web" link uses.
 *
 * Production kortix.com for every build (Jay, 2026-09-24) — never
 * `EXPO_PUBLIC_FRONTEND_URL`, never a value inferred from the backend URL. A
 * dev build pointed at a local backend used to open `http://localhost:3000/...`
 * on the phone, where nothing runs. The one exception is a self-hosted instance
 * the user chose on the auth screen: its web origin is what they entered.
 */
import { resolveEndpoints } from '@/lib/deployment/deployment';
import { activeDeployment } from '@/lib/deployment/store';

export const KORTIX_WEB_URL = resolveEndpoints(activeDeployment, {}).webUrl;
