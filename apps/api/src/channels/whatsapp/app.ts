import { makeOpenApiApp } from '../../openapi';

export const whatsappWebhookApp = makeOpenApiApp();

export const WHATSAPP_EVENT_DEDUPE_TTL_MS = 5 * 60 * 1000;
