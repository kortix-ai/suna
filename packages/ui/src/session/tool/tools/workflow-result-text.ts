import { parseWorkflowResult } from '@kortix/sdk';

/**
 * A workflow's result as Markdown a person reads. A document (a JSON object of
 * prose, even one cut short) is the document itself; data is a fenced `json`
 * block. A report without the `<workflow_result>` tag (a finish notice carries
 * the bare body) reads the same way.
 */
export function workflowResultMarkdown(text: string): string {
  const parsed = parseWorkflowResult(text.includes('<workflow_result>') ? text : `<workflow_result>${text}</workflow_result>`);
  if (!parsed) return text.trim();
  return parsed.kind === 'json' ? `\`\`\`json\n${parsed.text}\n\`\`\`` : parsed.text;
}

const RESULT_BLOCK = /<workflow_result>([\s\S]*?)(<\/workflow_result>|$)/g;

/**
 * Assistant text that carries a `<workflow_result>` block (a workflow runner's
 * last reply): the block becomes its readable result, never the tag and the JSON.
 * Each result stands on its own lines, so text around it stays text. An unclosed
 * block (still streaming, or cut) runs to the end of the text; while its JSON is
 * not yet readable as a document it shows nothing rather than its source.
 */
export function unwrapWorkflowResultBlocks(text: string): string {
  if (!text.includes('<workflow_result>')) return text;
  return text
    .replace(RESULT_BLOCK, (_, body: string, close: string) => {
      const readable = workflowResultMarkdown(`<workflow_result>${body}</workflow_result>`);
      if (!close && /^\s*[{[]/.test(body) && /^[{[]/.test(readable)) return '\n\n';
      return `\n\n${readable}\n\n`;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
