import { describe, expect, test } from 'bun:test';

import { renderEnvironmentExports } from './hydrate-environment-secret.mjs';

describe('renderEnvironmentExports', () => {
  test('renders quoted POSIX exports without overriding explicit values', () => {
    expect(
      renderEnvironmentExports(
        JSON.stringify({
          SIMPLE: 'value',
          QUOTED: "single ' quote",
          MULTILINE: 'first\nsecond',
          EXPLICIT: 'blob-value',
        }),
        { EXPLICIT: 'task-definition-value' },
      ),
    ).toBe(
      [
        "export SIMPLE='value'",
        `export QUOTED='single '\"'\"' quote'`,
        "export MULTILINE='first\nsecond'",
      ].join('\n'),
    );
  });

  test('rejects malformed JSON and non-string values', () => {
    expect(() => renderEnvironmentExports('not-json', {})).toThrow(
      'KORTIX_ENV_JSON must contain a JSON object',
    );
    expect(() => renderEnvironmentExports('{"PORT":3000}', {})).toThrow(
      'KORTIX_ENV_JSON key "PORT" must be a string',
    );
  });

  test('rejects keys that cannot be exported safely', () => {
    expect(() => renderEnvironmentExports('{"BAD-NAME":"value"}', {})).toThrow(
      'KORTIX_ENV_JSON key "BAD-NAME" is not a valid environment name',
    );
  });
});
