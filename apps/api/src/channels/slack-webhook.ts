// Barrel: the Slack webhook app split into ./slack/* modules. Importing
// './slack/routes' for its side effect registers the 4 OpenAPI routes on
// slackWebhookApp (in original order). Public exports are preserved exactly so
// existing importers (projects/routes/r4.ts, channels/index.ts) keep working
// with no import-path change.
import './slack/routes';

export { slackWebhookApp } from './slack/app';
export { postQuestionAndWait, relayTurnStep, relayTurnAnswer, relayTurnEnd } from './slack/questions';
export type { QuestionInfo } from './slack/questions';
