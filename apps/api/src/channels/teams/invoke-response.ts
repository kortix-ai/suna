export interface TeamsInvokeResponse {
  statusCode: number;
  type: string;
  value: unknown;
}

export function cardResponse(card: unknown): TeamsInvokeResponse {
  return { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card };
}

/** An answer to the presser alone: the card keeps its buttons for anyone else. */
export function messageResponse(text: string): TeamsInvokeResponse {
  return { statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: text };
}
