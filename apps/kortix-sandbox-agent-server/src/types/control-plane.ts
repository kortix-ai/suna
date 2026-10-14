/**
 * The first turn a session boot claims from the control plane
 * (`POST /projects/:id/turn-stream`, `kind: 'initial_turn_claim'`), as both
 * harness adapters hold it after parsing the API's `initial_turn` block.
 */
export interface InitialTurnClaim {
  prompt: string
  /**
   * Harness context stored beside the prompt at create (e.g. the CLI's worker
   * contract). OpenCode delivers it as a synthetic (model-only) message part;
   * pi still appends it to the prompt text. Absent on APIs predating the field.
   */
  context?: string
  turnToken: string
  messageId: string
}
