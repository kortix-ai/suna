import { expect, test } from 'bun:test';
import { validateAgentStateAppend } from './session-agent-state';

const item = (revision = 1, schemaVersion = 1, value: unknown = { count: 1 }) => ({
  kind: 'journal',
  stream: 'kortix.pi.agent-state.v1',
  record: { namespace: 'counter', revision, schemaVersion, value },
});

test('agent state validates initial writes, revision conflicts and forward migrations', () => {
  expect(() => validateAgentStateAppend([], item())).not.toThrow();
  expect(() => validateAgentStateAppend([item()], item())).toThrow(/revision/);
  expect(() => validateAgentStateAppend([item()], item(3))).toThrow(/revision/);
  expect(() => validateAgentStateAppend([item()], item(2, 2))).not.toThrow();
  expect(() => validateAgentStateAppend([item(1, 2)], item(2, 1))).toThrow(/schema/);
});

test('state namespaces are independent and malformed or oversized input is rejected', () => {
  expect(() =>
    validateAgentStateAppend([item()], {
      ...item(),
      record: { ...item().record, namespace: 'other' },
    }),
  ).not.toThrow();
  for (const value of [
    undefined,
    { kind: 'journal', stream: 'other', record: {} },
    { ...item(), record: { ...item().record, namespace: '../counter' } },
    item(1, 0),
    item(1, 1, 'x'.repeat(65537)),
  ])
    expect(() => validateAgentStateAppend([], value)).toThrow();
});

test('namespace and history quotas reject writes before storage changes', () => {
  const namespaces = Array.from({ length: 128 }, (_, index) => ({
    ...item(),
    record: { ...item().record, namespace: `n${index}` },
  }));
  expect(() => validateAgentStateAppend(namespaces, item())).toThrow(/namespace limit/);
  const history = Array.from({ length: 4096 }, (_, index) => item(index + 1));
  expect(() => validateAgentStateAppend(history, item(4097))).toThrow(/history limit/);
});
