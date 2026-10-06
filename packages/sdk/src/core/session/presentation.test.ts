import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiError } from '../http/api/errors';
import {
  buildPresentationTemplateImageUrl,
  buildPresentationTemplatePdfUrl,
  buildRuntimePresentationConversionUrl,
} from './presentation';

test('the presentation-template URL builders are retired: the API serves no /presentation-templates route', () => {
  for (const build of [buildPresentationTemplatePdfUrl, buildPresentationTemplateImageUrl]) {
    let error: unknown;
    try {
      build('https://api.example.test/v1/', 'tpl 1');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('ENDPOINT_RETIRED');
    expect((error as ApiError).message).toBe(
      `${build.name}() is retired: the Kortix API no longer serves this endpoint.`,
    );
  }
});

test('the runtime presentation conversion URL is built on the runtime base', () => {
  expect(buildRuntimePresentationConversionUrl('https://runtime.example.test/', 'pdf')).toBe(
    'https://runtime.example.test/presentation/convert-to-pdf',
  );
});

test('URL helpers do not use a backtracking trailing-slash expression', () => {
  const sources = [
    resolve(import.meta.dir, 'presentation.ts'),
    resolve(import.meta.dir, '../rest/platform-client/host-boundary.ts'),
    resolve(import.meta.dir, '../stream/fetch-sse.ts'),
  ].map((file) => readFileSync(file, 'utf8'));

  for (const source of sources) {
    expect(source).not.toContain("replace(/\\/+$/, '')");
  }
});
