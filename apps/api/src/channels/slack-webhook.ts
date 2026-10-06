// Barrel: the Slack webhook app split into ./slack/* modules.
// registerSlackWebhookRoutes() registers the OpenAPI routes on slackWebhookApp
// (in original order); app.ts calls it right before it mounts the app. Public
// exports are preserved exactly so existing importers
// (projects/routes/turn-questions.ts, channels/index.ts) keep working with no
// import-path change.
export { slackWebhookApp } from './slack/app';
export { registerSlackWebhookRoutes } from './slack/routes';
export { postQuestion } from './slack/questions';
export { postReviewCard } from './slack/review';
export { relayTurnStep, relayTurnAnswer, relayTurnEnd } from './slack/turn';
export type { QuestionInfo } from './slack/questions';
