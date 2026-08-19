import { getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Node as PMNode } from '@tiptap/pm/model';
import { describe, expect, test } from 'bun:test';

import {
  COMMAND_CHIP_ATTRIBUTE,
  COMMAND_CHIP_LABEL_ATTRIBUTE,
  COMMAND_CHIP_SELECTOR,
  COMMAND_CHIP_VALUE,
  draftWillRunCommand,
  planCommandAttachments,
  readCommandChipLabel,
} from './command-attachments';
import { MentionNode } from './editor/mention-node';

describe('planCommandAttachments', () => {
  test('a command with no attachments dispatches', () => {
    expect(planCommandAttachments({ isCommand: true, attachmentCount: 0 })).toEqual({
      kind: 'dispatch',
    });
  });

  test('a plain message with attachments dispatches — the guard is command-only', () => {
    // The ordinary prompt path DOES carry files end to end. Refusing here
    // would break the feature this guard exists to protect.
    expect(planCommandAttachments({ isCommand: false, attachmentCount: 3 })).toEqual({
      kind: 'dispatch',
    });
  });

  test('a command with one attachment is refused', () => {
    const plan = planCommandAttachments({ isCommand: true, attachmentCount: 1 });
    expect(plan.kind).toBe('refuse');
  });

  test('the refusal names the singular file count and says the file is kept', () => {
    const plan = planCommandAttachments({ isCommand: true, attachmentCount: 1 });
    if (plan.kind !== 'refuse') throw new Error('expected a refusal');
    expect(plan.description).toContain('1 file');
    expect(plan.description).toContain('stays attached');
    expect(plan.description).not.toContain('1 files');
  });

  test('the refusal names the plural file count and says the files are kept', () => {
    const plan = planCommandAttachments({ isCommand: true, attachmentCount: 3 });
    if (plan.kind !== 'refuse') throw new Error('expected a refusal');
    expect(plan.description).toContain('3 files');
    expect(plan.description).toContain('stay attached');
  });

  test('the refusal states the command cannot send attachments', () => {
    const plan = planCommandAttachments({ isCommand: true, attachmentCount: 2 });
    if (plan.kind !== 'refuse') throw new Error('expected a refusal');
    // The one message the user must never get is silence. The headline names
    // the command as the reason so the fix is obvious without a doc.
    expect(plan.message.toLowerCase()).toContain('command');
    expect(plan.message.toLowerCase()).toContain('attachment');
  });

  test('a negative or fractional count cannot produce a refusal', () => {
    // `attachmentCount` comes from `attachedFiles.length`, so this is defensive
    // only — but a refusal the user cannot clear would lock the composer.
    expect(planCommandAttachments({ isCommand: true, attachmentCount: 0 }).kind).toBe('dispatch');
    expect(planCommandAttachments({ isCommand: true, attachmentCount: -1 }).kind).toBe('dispatch');
  });
});

describe('readCommandChipLabel', () => {
  /** The two methods the read touches, and a record of what it asked for. */
  function host(attributes: Record<string, string> | null) {
    const asked: string[] = [];
    return {
      asked,
      querySelector(selectors: string) {
        asked.push(selectors);
        if (!attributes) return null;
        return { getAttribute: (name: string) => attributes[name] ?? null };
      },
    };
  }

  test('no editor element yet — nothing to read', () => {
    expect(readCommandChipLabel(null)).toBeNull();
  });

  test('no command chip in the draft', () => {
    expect(readCommandChipLabel(host(null))).toBeNull();
  });

  test('returns the command name off the chip', () => {
    expect(readCommandChipLabel(host({ [COMMAND_CHIP_LABEL_ATTRIBUTE]: 'webapp' }))).toBe('webapp');
  });

  test('a chip with no label reads as no command, never as an empty name', () => {
    // `draftWillRunCommand('')` is false anyway, but returning '' here would
    // make the two representations of "nothing" differ for no reason.
    expect(readCommandChipLabel(host({}))).toBeNull();
  });

  test('queries by the pinned command-chip selector', () => {
    const element = host(null);
    readCommandChipLabel(element);
    expect(element.asked).toEqual([COMMAND_CHIP_SELECTOR]);
  });
});

describe('draftWillRunCommand', () => {
  const commands = [{ name: 'webapp' }, { name: 'review' }];

  test('no chip in the draft — this is an ordinary message', () => {
    expect(draftWillRunCommand(null, commands)).toBe(false);
    expect(draftWillRunCommand(undefined, commands)).toBe(false);
    expect(draftWillRunCommand('', commands)).toBe(false);
  });

  test('a chip naming a live command will run that command', () => {
    expect(draftWillRunCommand('webapp', commands)).toBe(true);
  });

  test('a chip naming a command that is gone will NOT run — it degrades to text', () => {
    // Mirrors `planDraftSubmission`'s third branch: an unresolvable chip is
    // re-inlined as plain text and sent as a message, which DOES carry files.
    // Warning there would disable a send that is about to work fine.
    expect(draftWillRunCommand('deleted-skill', commands)).toBe(false);
  });

  test('an empty command list resolves nothing', () => {
    expect(draftWillRunCommand('webapp', [])).toBe(false);
  });
});

/**
 * The live-warning path finds the `/` chip by querying the editor's DOM, so
 * the selector is a real coupling to `MentionNode`'s rendered attributes.
 * These tests build the actual schema and read the actual `toDOM` output, so
 * renaming the attribute in `mention-node.ts` fails here instead of silently
 * disabling the warning.
 */
const schema = getSchema([Document, Paragraph, Text, MentionNode]);

function chipAttributes(kind: string): Record<string, string> {
  const node = PMNode.fromJSON(schema, {
    type: 'mention',
    attrs: { kind, label: 'webapp', value: 'webapp' },
  });
  const rendered = schema.nodes.mention.spec.toDOM?.(node) as [
    string,
    Record<string, string>,
    ...unknown[],
  ];
  return rendered[1];
}

describe('COMMAND_CHIP_SELECTOR', () => {
  test('matches the attribute a command chip actually renders', () => {
    expect(chipAttributes('command')[COMMAND_CHIP_ATTRIBUTE]).toBe(COMMAND_CHIP_VALUE);
  });

  test('does not match a file mention chip', () => {
    expect(chipAttributes('file')[COMMAND_CHIP_ATTRIBUTE]).not.toBe(COMMAND_CHIP_VALUE);
  });

  test('is built from the attribute and value it pins', () => {
    expect(COMMAND_CHIP_SELECTOR).toBe(`[${COMMAND_CHIP_ATTRIBUTE}="${COMMAND_CHIP_VALUE}"]`);
  });

  test('the label attribute carries the command name the chip was built with', () => {
    // `draftWillRunCommand` resolves this string against the live command
    // list, exactly as `collectCommandName` -> `planDraftSubmission` does.
    expect(chipAttributes('command')[COMMAND_CHIP_LABEL_ATTRIBUTE]).toBe('webapp');
  });
});
