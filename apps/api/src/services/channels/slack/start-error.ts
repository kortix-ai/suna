import {
  SLACK_START_ERROR_COMMANDS,
  startErrorMessage as classify,
} from '../start-error';

/**
 * Slack's binding of the shared channel start-error classifier.
 *
 * The classification, the copy and the ordering live in `../start-error.ts`
 * because Teams needs exactly the same answers; only the command a user is
 * pointed at differs. This wrapper keeps every Slack call site — and its unit
 * test — on the two-argument signature they already use.
 */
export function startErrorMessage(status: number | undefined, body: unknown): string {
  return classify(status, body, SLACK_START_ERROR_COMMANDS);
}
