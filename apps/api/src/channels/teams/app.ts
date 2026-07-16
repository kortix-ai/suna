import { makeOpenApiApp } from '../../openapi';

export const teamsWebhookApp = makeOpenApiApp();

export const EVENT_DEDUPE_TTL_MS = 5 * 60 * 1000;
export const STREAM_TTL_MS = 15 * 60 * 1000;
export const STALE_AFTER_MS = 30 * 60 * 1000;
