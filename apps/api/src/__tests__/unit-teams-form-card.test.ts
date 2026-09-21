import { describe, expect, test } from 'bun:test';
import { TEAMS_FORM_VERB, buildFormCard } from '../channels/teams/cards';

/**
 * Teams' only rich surface is the Adaptive Card, and a card can carry real
 * inputs. Before this the agent could only write its questions as prose and
 * ask the user to type a reply, or hand over raw card JSON whose Submit went
 * nowhere because no verb handled it.
 *
 * The card is built server-side so the submit verb, the field ids and the
 * branding cannot drift — `channels/teams/interactivity.ts` reads the answers
 * back under exactly this verb.
 */
describe('buildFormCard', () => {
  const card = buildFormCard({
    title: 'Deploy details',
    subtitle: 'Two things before I start',
    submitLabel: 'Deploy',
    fields: [
      { id: 'env', label: 'Environment', type: 'choice', choices: ['prod', 'staging'], required: true },
      { id: 'notes', label: 'Notes', type: 'textarea', placeholder: 'anything I should know' },
      { id: 'dry', label: 'Dry run first', type: 'toggle' },
    ],
  })!;

  const body = card.body as Array<Record<string, unknown>>;
  const actions = card.actions as Array<Record<string, unknown>>;

  test('renders one Adaptive Card input per field', () => {
    const types = body.filter((b) => String(b.type).startsWith('Input.')).map((b) => b.type);
    expect(types).toEqual(['Input.ChoiceSet', 'Input.Text', 'Input.Toggle']);
  });

  test('a required field carries its own error message', () => {
    const choice = body.find((b) => b.type === 'Input.ChoiceSet')!;
    expect(choice.isRequired).toBe(true);
    expect(choice.errorMessage).toBe('Environment is required');
  });

  test('a textarea is multiline and keeps its placeholder', () => {
    const notes = body.find((b) => b.type === 'Input.Text')!;
    expect(notes.isMultiline).toBe(true);
    expect(notes.placeholder).toBe('anything I should know');
  });

  test('a toggle renders its own label and is not labelled twice', () => {
    const toggle = body.find((b) => b.type === 'Input.Toggle')!;
    expect(toggle.title).toBe('Dry run first');
    expect(body.filter((b) => b.type === 'TextBlock' && b.text === 'Dry run first')).toHaveLength(0);
  });

  test('Submit is an Action.Execute on the verb the invoke handler reads', () => {
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe('Action.Execute');
    expect(actions[0]!.title).toBe('Deploy');
    expect(actions[0]!.verb).toBe(TEAMS_FORM_VERB);
  });

  test('the field ids ride along so the handler reads back what was asked, in order', () => {
    expect((actions[0]!.data as Record<string, unknown>).fieldIds).toBe('env,notes,dry');
  });

  test('string choices become title/value pairs', () => {
    const choice = body.find((b) => b.type === 'Input.ChoiceSet')!;
    expect(choice.choices).toEqual([
      { title: 'prod', value: 'prod' },
      { title: 'staging', value: 'staging' },
    ]);
  });

  // A dead Submit is worse than no card: the user fills it in and nothing happens.
  test('a spec with no usable field is refused rather than rendered', () => {
    expect(buildFormCard({ fields: [] })).toBeNull();
    expect(buildFormCard({ fields: [{ id: '  ', label: 'nameless' }] })).toBeNull();
    expect(buildFormCard({ fields: [{ id: 'x', label: 'Pick', type: 'choice', choices: [] }] })).toBeNull();
    // `fieldIds` is comma-joined on the submit action, so a comma in an id
    // would split one answer into two when it comes back.
    expect(buildFormCard({ fields: [{ id: 'a,b', label: 'Comma' }] })).toBeNull();
  });
});
