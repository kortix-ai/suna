/** The `{{field}}` names of a template, in order of first use. */
export const templateFields = (body: string) => [...new Set([...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))];
