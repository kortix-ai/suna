/** New verbs default to the calling session; legacy positional syntax is unchanged. */
export function sessionModelTarget(positional: string[], current: string | undefined) {
  const [first, ...args] = positional;
  if (first === 'get') return { action: first, sessionId: args[0] ?? current, model: undefined };
  if (first === 'set' || first === 'switch') {
    return { action: first, sessionId: args.length > 1 ? args[0] : current, model: args.at(-1) };
  }
  return { action: undefined, sessionId: first, model: args[0] };
}
