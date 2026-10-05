import { tagBlocks } from './tag-blocks';

/**
 * The prompt of a trigger-started session carries the event that fired it as
 * `<trigger_event>{…json…}</trigger_event>`, then the prompt text.
 *
 * Not `/<trigger_event>\s*([\s\S]*?)\s*<\/trigger_event>/`: that regex was
 * cubic when the tag never closed (1,000 characters took ~180 ms, 10,000 took
 * minutes) and quadratic on a long whitespace run inside the payload. A webhook
 * chooses that payload, and web and mobile both parse it on every render.
 */
export interface TriggerEventInfo {
  /** The event JSON. Its shape belongs to the trigger that fired it. */
  // biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON; readers use optional chaining.
  data: any;
  /** The prompt text around the tag, trimmed. */
  prompt: string;
}

/**
 * The first `<trigger_event>` block's JSON and the prompt without it, as the
 * regex version read them; undefined when there is no closed block or its body
 * is not JSON.
 */
export function parseTriggerEvent(
  rawText: string | null | undefined,
): TriggerEventInfo | undefined {
  if (!rawText) return undefined;
  const [block] = tagBlocks(rawText, 'trigger_event', { limit: 1 });
  if (!block) return undefined;
  try {
    // The regex captured the body without the whitespace around it.
    const data = JSON.parse(block.body.trim());
    const prompt = (rawText.slice(0, block.index) + rawText.slice(block.end)).trim();
    return { data, prompt };
  } catch {
    return undefined;
  }
}
