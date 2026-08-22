/**
 * BYOK state is loaded once the project's secrets have resolved. Project
 * detail used to be a second input, read only for the retired `llm_gateway`
 * flag; gateway mode is the only mode, so it is not consulted.
 */
export function isProviderStateLoading(input: { secretsLoading: boolean }): boolean {
  return input.secretsLoading;
}
