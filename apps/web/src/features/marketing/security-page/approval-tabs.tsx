import { CodeTabs } from '@/features/marketing/kit/code-tabs';

type Note = { readonly id: string; readonly k: string; readonly v: string };

/**
 * The approval rules as `CodeTabs`: each note shows the part of kortix.yaml it
 * is about. `slices` maps a note id to a yaml line range; a note with no slice
 * shows the whole file.
 */
export function ApprovalTabs({
  notes,
  title,
  lines,
  slices,
}: {
  notes: readonly Note[];
  title: string;
  lines: readonly string[];
  slices: Record<string, readonly [number, number]>;
}) {
  return (
    <CodeTabs
      label="Approval rules"
      tabs={notes.map((note) => {
        const range = slices[note.id];
        return { ...note, panel: { title, lines: range ? lines.slice(range[0], range[1]) : lines, lang: 'yaml' } };
      })}
    />
  );
}
