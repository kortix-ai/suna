import { describe, expect, test } from 'bun:test';

import { TEAMS_FORM_VERB, buildQuestionCard } from '../channels/teams/cards';

// The old card flattened EVERY option of EVERY question into one deduped
// button row. Two questions offering "Yes" showed a single button, nothing
// said which question a button belonged to, and one tap answered what were
// several questions. `header`, `multiple`, `custom` and every option
// `description` were dropped on the floor.

type Card = { body: Array<Record<string, any>>; actions?: Array<Record<string, any>> };

const walk = (node: unknown, out: Array<Record<string, any>> = []): Array<Record<string, any>> => {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  out.push(node as Record<string, any>);
  Object.values(node as Record<string, unknown>).forEach((v) => walk(v, out));
  return out;
};
const nodes = (c: unknown) => walk(c);
const ofType = (c: unknown, t: string) => nodes(c).filter((n) => n.type === t);
const allText = (c: unknown) => JSON.stringify(c);

describe('buildQuestionCard — one question, one answer', () => {
  const card = buildQuestionCard([
    { question: 'Deploy to prod?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ]) as unknown as Card;

  test('stays a one-tap button card', () => {
    expect(card.actions?.map((a) => a.title)).toEqual(['Yes', 'No']);
    expect(card.actions?.every((a) => a.verb === 'teams_answer')).toBe(true);
    expect(ofType(card, 'Input.ChoiceSet')).toHaveLength(0);
  });

  test('still says a plain reply works', () => {
    expect(allText(card)).toContain('or just reply in the chat');
  });

  test('an option description is shown instead of discarded', () => {
    const described = buildQuestionCard([
      { question: 'Merge?', options: [{ label: 'Yes', description: 'squash into main' }, { label: 'No' }] },
    ]);
    expect(allText(described)).toContain('squash into main');
  });

  test('a custom header replaces the generic one', () => {
    const c = buildQuestionCard([
      { question: 'Ship it?', header: 'Release gate', options: [{ label: 'Yes' }, { label: 'No' }] },
    ]);
    expect(allText(c)).toContain('Release gate');
    expect(allText(c)).not.toContain('A quick question');
  });
});

describe('buildQuestionCard — anything the buttons cannot express becomes a form', () => {
  test('two questions get one input EACH, and the submit names both', () => {
    const card = buildQuestionCard([
      { question: 'Which environment?', options: [{ label: 'dev' }, { label: 'prod' }] },
      { question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ]) as unknown as Card;

    const sets = ofType(card, 'Input.ChoiceSet');
    expect(sets).toHaveLength(2);
    expect(sets.map((s) => s.id)).toEqual(['Which environment?', 'Proceed?']);
    // `handleForm` relays `- <id>: <value>`, so the id has to BE the question
    // or the agent reads back "q1: dev" and learns nothing.
    expect(card.actions?.[0].verb).toBe(TEAMS_FORM_VERB);
    expect(card.actions?.[0].data.fieldIds).toBe('Which environment?,Proceed?');
  });

  test('two questions that share an option label keep both', () => {
    // The old dedup by label deleted the second question's "Yes" outright.
    const card = buildQuestionCard([
      { question: 'Run tests?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ]);
    const sets = ofType(card, 'Input.ChoiceSet');
    expect(sets).toHaveLength(2);
    for (const s of sets) expect(s.choices.map((c: any) => c.value)).toEqual(['Yes', 'No']);
  });

  test('`multiple` becomes a real multi-select', () => {
    const card = buildQuestionCard([
      { question: 'Which surfaces?', multiple: true, options: [{ label: 'api' }, { label: 'web' }] },
    ]);
    expect(ofType(card, 'Input.ChoiceSet')[0].isMultiSelect).toBe(true);
  });

  test('`custom` adds a box for an answer that is not on the list', () => {
    // Only once a form is warranted for some OTHER reason — here, two questions.
    const card = buildQuestionCard([
      { question: 'Which model?', custom: true, options: [{ label: 'a' }, { label: 'b' }] },
      { question: 'Proceed?', options: [{ label: 'Yes' }] },
    ]) as unknown as Card;
    expect(ofType(card, 'Input.Text')).toHaveLength(1);
    expect(card.actions?.[0].data.fieldIds).toBe('Which model?,Which model? (other),Proceed?');
  });

  test('`custom` ALONE never forces a form — the relay route defaults it to true', () => {
    // projects/routes/r4.ts:3839 is `obj.custom === false ? false : true`, so
    // nearly every question arrives with custom set. Gating the one-tap card on
    // it would turn every plain yes/no into a form with a Submit button.
    // Replying in chat is already the free-text path, and the card says so.
    const card = buildQuestionCard([
      { question: 'Deploy to prod?', options: [{ label: 'Yes' }, { label: 'No' }], multiple: false, custom: true },
    ]) as unknown as Card;
    expect(card.actions?.map((a) => a.title)).toEqual(['Yes', 'No']);
    expect(ofType(card, 'Input.Text')).toHaveLength(0);
    expect(ofType(card, 'Input.ChoiceSet')).toHaveLength(0);
    expect(allText(card)).toContain('or just reply in the chat');
  });

  test('a question with no options becomes a text box, not a dead card', () => {
    const card = buildQuestionCard([{ question: 'Name the branch?', options: [] }]);
    const box = ofType(card, 'Input.Text')[0];
    expect(box.isMultiline).toBe(true);
    expect(box.id).toBe('Name the branch?');
  });

  test('more options than fit as buttons become a picker rather than truncating', () => {
    // The old card capped at 6 and silently dropped the rest.
    const card = buildQuestionCard([
      { question: 'Pick a model', options: Array.from({ length: 8 }, (_, i) => ({ label: `m${i}` })) },
    ]);
    expect(ofType(card, 'Input.ChoiceSet')[0].choices).toHaveLength(8);
  });

  test('an option description rides on the choice the user reads', () => {
    const card = buildQuestionCard([
      { question: 'Which surfaces?', multiple: true, options: [{ label: 'api', description: 'the Bun server' }] },
    ]);
    expect(ofType(card, 'Input.ChoiceSet')[0].choices[0]).toEqual({
      title: 'api — the Bun server',
      value: 'api',
    });
  });
});

describe('buildQuestionCard — degenerate input', () => {
  test('no questions still produces a card that says so', () => {
    expect(allText(buildQuestionCard([]))).toContain('arrived empty');
  });

  test('a blank question is dropped, not rendered', () => {
    const card = buildQuestionCard([
      { question: '   ', options: [{ label: 'x' }] },
      { question: 'Real one?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ]) as unknown as Card;
    // One real question left ⇒ back to the one-tap shape.
    expect(card.actions?.map((a) => a.title)).toEqual(['Yes', 'No']);
  });

  test('a comma in the question never splits one field into two on the way back', () => {
    // `fieldIds` travels comma-joined; a raw comma would desynchronise it.
    const card = buildQuestionCard([
      { question: 'Which env, exactly?', options: [{ label: 'dev' }] },
      { question: 'Proceed?', options: [{ label: 'Yes' }] },
    ]) as unknown as Card;
    const ids = String(card.actions?.[0].data.fieldIds).split(',');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('Which env exactly?');
  });

  test('a very long question is truncated to stay readable in the relay', () => {
    const long = `${'x'.repeat(200)}?`;
    const card = buildQuestionCard([
      { question: long, options: [{ label: 'a' }] },
      { question: 'Second?', options: [{ label: 'b' }] },
    ]) as unknown as Card;
    const id = String(card.actions?.[0].data.fieldIds).split(',')[0];
    expect(id.length).toBeLessThanOrEqual(60);
    expect(id).toEndWith('…');
  });
});

// `Action.Execute` REPLACES the card it was tapped on. Without the question
// travelling with the answer, the conversation is left showing a bare "Answer
// received: Yes" — no context for anyone reading the channel later — and the
// agent receives a bare label for a question it can only infer.
describe('buildQuestionCard — the answer carries its question', () => {
  test('each button sends the question back alongside the answer', () => {
    const card = buildQuestionCard([
      { question: 'Deploy to prod?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ]) as unknown as Card;

    expect(card.actions?.map((a) => a.data)).toEqual([
      { verb: 'teams_answer', answer: 'Yes', question: 'Deploy to prod?' },
      { verb: 'teams_answer', answer: 'No', question: 'Deploy to prod?' },
    ]);
  });

  test('a long question is truncated — action data travels on every tap', () => {
    const card = buildQuestionCard([
      { question: 'x'.repeat(500), options: [{ label: 'Yes' }] },
    ]) as unknown as Card;

    expect(String(card.actions?.[0].data.question)).toHaveLength(200);
  });
});
