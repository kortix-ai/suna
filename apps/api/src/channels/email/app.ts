import { makeOpenApiApp } from '../../openapi';

export const emailWebhookApp = makeOpenApiApp();

export const EMAIL_EVENT_DEDUPE_TTL_MS = 5 * 60 * 1000;
