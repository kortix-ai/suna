import { describe, expect, test } from 'bun:test';
import { projectModelsWebUrl } from './connect-model';

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
