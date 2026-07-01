import type { Effect } from 'effect';
// Barrel: the Slack webhook app split into ./slack/* modules. Importing
// './slack/routes' for its side effect registers the 4 OpenAPI routes on
// slackWebhookApp (in original order). Public exports are preserved exactly so
// existing importers (projects/routes/r4.ts, channels/index.ts) keep working
// with no import-path change.
import './slack/routes';

export { slackWebhookApp } from './slack/app';
export { postQuestion } from './slack/questions';
export { relayTurnStep, relayTurnAnswer, relayTurnEnd } from './slack/turn';
export type { QuestionInfo } from './slack/questions';
