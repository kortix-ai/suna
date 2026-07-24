import { expect, test } from 'bun:test';
import {
  buildPresentationTemplateImageUrl,
  buildPresentationTemplatePdfUrl,
  buildRuntimePresentationConversionUrl,
} from './presentation';

test('presentation URL helpers own platform and runtime routes', () => {
  expect(buildPresentationTemplatePdfUrl('https://api.example.test/v1/', 'tpl 1')).toBe(
    'https://api.example.test/v1/presentation-templates/tpl%201/pdf#toolbar=0&navpanes=0&scrollbar=0&view=FitH',
  );
  expect(buildPresentationTemplateImageUrl('https://api.example.test/v1', 'tpl 1')).toBe(
    'https://api.example.test/v1/presentation-templates/tpl%201/image.png',
  );
  expect(buildRuntimePresentationConversionUrl('https://runtime.example.test/', 'pdf')).toBe(
    'https://runtime.example.test/presentation/convert-to-pdf',
  );
});
