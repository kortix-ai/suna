import { describe, expect, test } from 'bun:test';
import {
  PROVIDER_CONNECTED_URI,
  isBrowserReturnPath,
  projectModelsWebUrl,
} from './connect-model';

describe('projectModelsWebUrl', () => {
  test('builds the project customize/models URL', () => {
    expect(projectModelsWebUrl('https://kortix.com', 'proj-1')).toBe(
      'https://kortix.com/projects/proj-1/customize/models',
    );
  });

  test('trims a trailing slash off the frontend URL', () => {
    expect(projectModelsWebUrl('https://kortix.com/', 'proj-1')).toBe(
      'https://kortix.com/projects/proj-1/customize/models',
    );
  });

  test('encodes the project id', () => {
    expect(projectModelsWebUrl('https://kortix.com', 'proj 1/étage')).toBe(
      'https://kortix.com/projects/proj%201%2F%C3%A9tage/customize/models',
    );
  });
});

describe('projectModelsWebUrl with a return URL', () => {
  test('adds return_to, URL-encoded', () => {
    expect(projectModelsWebUrl('https://kortix.com', 'proj-1', PROVIDER_CONNECTED_URI)).toBe(
      'https://kortix.com/projects/proj-1/customize/models?return_to=kortix%3A%2F%2Fproviders%2Fconnected',
    );
  });
});

describe('isBrowserReturnPath', () => {
  test('matches the in-app browser return URLs, in every form the router sees', () => {
    expect(isBrowserReturnPath('kortix://providers/connected')).toBe(true);
    expect(isBrowserReturnPath('/providers/connected')).toBe(true);
    expect(isBrowserReturnPath('providers')).toBe(true);
    expect(isBrowserReturnPath('kortix://connectors/success?x=1')).toBe(true);
    expect(isBrowserReturnPath('kortix://connections/error')).toBe(true);
  });

  test('leaves real routes alone', () => {
    expect(isBrowserReturnPath('/projects/p1')).toBe(false);
    expect(isBrowserReturnPath('kortix://auth/callback?code=1')).toBe(false);
    expect(isBrowserReturnPath('/providersfoo')).toBe(false);
    expect(isBrowserReturnPath('/')).toBe(false);
  });
});
