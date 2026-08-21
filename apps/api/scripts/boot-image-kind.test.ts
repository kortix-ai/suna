import { describe, expect, test } from 'bun:test';
import {
  aggregateTelemetryImages,
  classifyBootImage,
  classifyTelemetryImage,
} from './boot-image-kind';

const SCOPED_PROJECT_IMAGE =
  'kpp2-111111111111-222222222222-3333333333333333-4444444444444444';

describe('classifyBootImage', () => {
  test('preserves historical project-image prefix classification', () => {
    expect(classifyBootImage('kortix-ppwarm-00ead866-f5c859f984f2')).toBe('ppwarm');
    expect(classifyBootImage('kortix-ppwarm-historical-provider-value')).toBe('ppwarm');
  });

  test('accepts only the exact scoped kpp2 shape', () => {
    expect(classifyBootImage(SCOPED_PROJECT_IMAGE)).toBe('ppwarm');
    expect(classifyBootImage('kpp2-not-an-image')).toBe('unknown');
    expect(
      classifyBootImage(
        'kpp2-111111111111-222222222222-333333333333333-4444444444444444',
      ),
    ).toBe('unknown');
    expect(classifyBootImage(`prefix-${SCOPED_PROJECT_IMAGE}`)).toBe('unknown');
  });

  test('preserves cold-image classification', () => {
    expect(classifyBootImage('kortix-default-runtime')).toBe('default-cold');
    expect(classifyBootImage('kortix-tpl-project')).toBe('per-project-tpl');
    expect(classifyBootImage('')).toBe('unknown');
    expect(classifyBootImage(null)).toBe('unknown');
  });

  test('maps the same classification to fleet-report labels', () => {
    expect(classifyTelemetryImage(SCOPED_PROJECT_IMAGE)).toBe('warm-hit');
    expect(classifyTelemetryImage('kpp2-not-an-image')).toBe('other');
    expect(classifyTelemetryImage('kortix-default-runtime')).toBe(
      'cold-shared-default',
    );
    expect(classifyTelemetryImage('kortix-tpl-project')).toBe(
      'cold-per-project-template',
    );
    expect(classifyTelemetryImage('')).toBe('other');
    expect(classifyTelemetryImage(null)).toBe('unknown');
  });

  test('aggregates historical and scoped hits into one provider bucket', () => {
    expect(
      aggregateTelemetryImages([
        { provider: 'daytona', image_ref: SCOPED_PROJECT_IMAGE, n: 2 },
        {
          provider: 'daytona',
          image_ref: 'kortix-ppwarm-00ead866-f5c859f984f2',
          n: 3,
        },
        { provider: 'daytona', image_ref: 'kpp2-not-an-image', n: 1 },
        { provider: 'platinum', image_ref: null, n: 4 },
      ]),
    ).toEqual([
      { provider: 'daytona', image_kind: 'warm-hit', n: 5 },
      { provider: 'daytona', image_kind: 'other', n: 1 },
      { provider: 'platinum', image_kind: 'unknown', n: 4 },
    ]);
  });
});
