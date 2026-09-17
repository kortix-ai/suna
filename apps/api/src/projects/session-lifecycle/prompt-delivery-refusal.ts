/** A permanent prompt refusal must escape the transient readiness retry loop. */
export class PromptDeliveryRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'PromptDeliveryRefused';
  }
}

export async function throwIfPromptRefused(response: Response): Promise<void> {
  // 404 heals a rotated runtime; 408/429 are transient. Unknown conflicts can
  // represent a busy runtime, so only classified 409 refusals are terminal.
  if (response.status < 400 || response.status >= 500 || [404, 408, 429].includes(response.status)) return;
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  const code = typeof body?.code === 'string' ? body.code : null;
  const terminalConflict =
    response.status === 409 &&
    (code === 'CONNECTOR_CONNECTION_REQUIRED' ||
      code === 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE');
  const terminalClientError =
    response.status >= 400 &&
    response.status < 500 &&
    ![404, 408, 409, 429].includes(response.status);
  if (!terminalConflict && !terminalClientError) return;
  const message =
    typeof body?.message === 'string'
      ? body.message
      : typeof body?.error === 'string'
        ? body.error
        : `Prompt rejected (HTTP ${response.status})`;
  throw new PromptDeliveryRefused(response.status, code, message);
}
