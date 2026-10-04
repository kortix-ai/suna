/**
 * The first turn a session boot claims from the control plane
 * (`POST /projects/:id/turn-stream`, `kind: 'initial_turn_claim'`), as both
 * harness adapters hold it after parsing the API's `initial_turn` block.
 */
export interface InitialTurnClaim {
  prompt: string
  turnToken: string
  messageId: string
}
