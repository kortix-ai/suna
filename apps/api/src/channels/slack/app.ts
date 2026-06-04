import { makeOpenApiApp } from '../../openapi';

export const slackWebhookApp = makeOpenApiApp();

export const FIVE_MINUTES = 5 * 60;

export const EVENT_DEDUPE_TTL_MS = 5 * 60 * 1000;

export const WORKING_EMOJI = 'hourglass_flowing_sand';
export const STREAM_TTL_MS = 15 * 60 * 1000;

export const ASK_TTL_MS = 15 * 60 * 1000;

export const PICKER_TTL_MS = 60 * 60 * 1000;
