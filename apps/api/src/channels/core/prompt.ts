/**
 * The `Reply:` line of a channel prompt (`channelPromptText` in `@kortix/shared`):
 * one connector call through the `kortix connectors` CLI, which every harness's
 * shell has. Quoted in backticks, as the prompt quotes every command.
 */
export function connectorReply(slug: string, action: string, args: Record<string, unknown>): string {
  return `\`kortix connectors call ${slug}.${action} '${JSON.stringify(args)}'\``;
}
