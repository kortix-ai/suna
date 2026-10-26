import { CodeTabs } from '@/features/marketing/kit/code-tabs';

type Note = { readonly id: string; readonly k: string; readonly v: string };

/**
 * The approval rules as `CodeTabs`: the whole kortix.yaml stays on screen and
 * each note brightens the lines it is about. `slices` maps a note id to a
 * [start, end) line range; a note with no slice keeps every line bright.
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
        // The whole file stays on screen; the note's lines stay bright.
        return { ...note, panel: { title, lines, lang: 'yaml', focus: range } };
      })}
    />
  );
}
