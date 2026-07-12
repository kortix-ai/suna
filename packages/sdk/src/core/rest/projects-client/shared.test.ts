import { expect, test } from 'bun:test';

import { unwrap } from './shared';

test('unwrap returns the data on success', () => {
  expect(unwrap({ success: true, data: { a: 1 } })).toEqual({ a: 1 });
});

test('unwrap throws the response error verbatim when one is present', () => {
  const error = new Error('server says no');
  expect(() => unwrap({ success: false, error })).toThrow('server says no');
});

test('unwrap falls back to the default message when there is no response error', () => {
  expect(() => unwrap({ success: false })).toThrow('Project request failed');
});

test('unwrap falls back to a caller-supplied message instead of the generic default', () => {
  expect(() => unwrap({ success: false }, 'Failed to connect')).toThrow('Failed to connect');
});

test('unwrap treats success:true with no data as a failure too', () => {
  expect(() => unwrap({ success: true }, 'Failed to load Slack manifest')).toThrow(
    'Failed to load Slack manifest',
  );
});
