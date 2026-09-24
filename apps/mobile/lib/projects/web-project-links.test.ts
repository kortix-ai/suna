import { describe, expect, test } from 'bun:test';

import {
  CONNECTORS_DONE_URI,
  CONNECTORS_RETURN_URL,
  projectConnectorsWebUrl,
  projectCustomizeWebUrl,
} from './web-project-links';
import { isBrowserReturnPath } from '@/lib/session/connect-model';

describe('projectCustomizeWebUrl', () => {
  test('builds the customize url', () => {
    expect(projectCustomizeWebUrl('https://kortix.com', 'proj-1')).toBe(
      'https://kortix.com/projects/proj-1/customize'
    );
  });

  test('strips a trailing slash from the frontend url', () => {
    expect(projectCustomizeWebUrl('https://kortix.com/', 'proj-1')).toBe(
      'https://kortix.com/projects/proj-1/customize'
    );
  });

  test('encodes the project id', () => {
    expect(projectCustomizeWebUrl('https://kortix.com', 'proj 1/2')).toBe(
      'https://kortix.com/projects/proj%201%2F2/customize'
    );
  });
});

describe('projectConnectorsWebUrl', () => {
  test('builds the customize connectors url', () => {
    expect(projectConnectorsWebUrl('https://kortix.com', 'proj-1')).toBe(
      'https://kortix.com/projects/proj-1/customize/connectors'
    );
  });

  test('strips a trailing slash and encodes the project id', () => {
    expect(projectConnectorsWebUrl('https://kortix.com/', 'proj 1/2')).toBe(
      'https://kortix.com/projects/proj%201%2F2/customize/connectors'
    );
  });

  test('adds return_to, encoded, when given', () => {
    expect(projectConnectorsWebUrl('https://kortix.com', 'proj-1', CONNECTORS_DONE_URI)).toBe(
      'https://kortix.com/projects/proj-1/customize/connectors?return_to=kortix%3A%2F%2Fconnectors%2Fdone'
    );
  });
});

describe('connectors return urls', () => {
  test('the done uri starts with the auth session prefix', () => {
    expect(CONNECTORS_DONE_URI.startsWith(CONNECTORS_RETURN_URL)).toBe(true);
  });

  test('the done uri is a browser return path, so Android never routes it', () => {
    expect(isBrowserReturnPath(CONNECTORS_DONE_URI)).toBe(true);
  });
});
