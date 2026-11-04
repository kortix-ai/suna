// The assistant's name: who it is in every prompt, the name it answers to (and hears sound-alikes of), the name it
// greets with. One setting, whatever we set: VOICE_NAME (default Kortix).
export const NAME = process.env.VOICE_NAME?.trim() || 'Kortix'
/** Who said a transcript line: a meeting line's speaker ("[Ana] ..." from a captions bridge), the assistant, the screen,
 * or a one-to-one caller. */
export const whoOf = (role: string, text: string) =>
  role === 'agent' ? NAME : role === 'screen' ? 'screen' : (text.match(/^\s*\[([^\]]{1,48})\]/)?.[1]?.trim() ?? 'caller')
