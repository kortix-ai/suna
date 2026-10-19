import { describe, expect, test } from 'bun:test';

import { getShowFileCategory } from '../file-renderers/show-type-utils';
import {
  framePolicy,
  getFileCategory,
  serviceFrameContent,
  type FrameContent,
  type FramePolicy,
} from './preview-policy';

function tokens(sandbox: string): string[] {
  return sandbox.split(/\s+/).filter(Boolean).sort();
}

// ─── Frames ─────────────────────────────────────────────────────────────────
// Every frame that shows agent-written content asks `framePolicy`. The table
// is the whole security contract: which token set, which origin, for each kind
// of content on each kind of host.
// ────────────────────────────────────────────────────────────────────────────

const APP = 'https://app.example.com';
const API = 'https://api.example.com/v1';
const PRIVILEGED = [APP, API];

const PREVIEW_HOST = 'https://3211--sbx1.preview.example.com/report.html';
const PATH_PROXY = 'https://api.example.com/v1/p/sbx1/3211/report.html';
const APP_ORIGIN = `${APP}/share/x.html`;
const RELATIVE = '/v1/p/sbx1/3211/report.html';
const BLOB = 'blob:https://app.example.com/5b1c-0000';
const UNPARSEABLE = 'http://:';

const DOCUMENT = ['allow-downloads', 'allow-forms', 'allow-popups', 'allow-scripts'];
const APP_OWN = [
  'allow-downloads',
  'allow-forms',
  'allow-modals',
  'allow-popups',
  'allow-same-origin',
  'allow-scripts',
];
const SLIDE_OWN = ['allow-modals', 'allow-same-origin', 'allow-scripts'];
const SLIDE_OPAQUE = ['allow-modals', 'allow-scripts'];

const FRAME_TABLE: [FrameContent, string, FramePolicy['origin'], string[]][] = [
  // A file the agent wrote is opaque on every host, its own preview host too.
  ['document', PREVIEW_HOST, 'opaque', DOCUMENT],
  ['document', PATH_PROXY, 'opaque', DOCUMENT],
  ['document', BLOB, 'opaque', DOCUMENT],
  // A server the agent runs keeps its origin only on a host of its own.
  ['app', PREVIEW_HOST, 'own', APP_OWN],
  ['app', PATH_PROXY, 'opaque', DOCUMENT],
  ['app', APP_ORIGIN, 'opaque', DOCUMENT],
  ['app', RELATIVE, 'opaque', DOCUMENT],
  ['app', BLOB, 'opaque', DOCUMENT],
  ['app', UNPARSEABLE, 'opaque', DOCUMENT],
  // Deck slides: scripts and modals, same origin rule as an app.
  ['slide', PREVIEW_HOST, 'own', SLIDE_OWN],
  ['slide', PATH_PROXY, 'opaque', SLIDE_OPAQUE],
  ['slide', UNPARSEABLE, 'opaque', SLIDE_OPAQUE],
];

describe('framePolicy', () => {
  for (const [content, src, origin, expected] of FRAME_TABLE) {
    test(`${content} at ${src} → ${origin}`, () => {
      const policy = framePolicy(content, src, PRIVILEGED);

      expect(policy.origin).toBe(origin);
      expect(tokens(policy.sandbox)).toEqual(expected);
    });
  }

  test('an opaque frame never carries allow-same-origin', () => {
    for (const [content, src] of FRAME_TABLE) {
      const policy = framePolicy(content, src, PRIVILEGED);
      if (policy.origin === 'opaque') {
        expect(tokens(policy.sandbox)).not.toContain('allow-same-origin');
      }
    }
  });
});

describe('serviceFrameContent', () => {
  test('the static file server serves documents', () => {
    expect(serviceFrameContent(3211)).toBe('document');
  });

  test('every other port is an app, and so is an unknown one', () => {
    expect(serviceFrameContent(3000)).toBe('app');
    expect(serviceFrameContent(3210)).toBe('app');
    expect(serviceFrameContent(undefined)).toBe('app');
  });
});

// ─── Renderer ───────────────────────────────────────────────────────────────
// One extension table. The `show` card derives its categories from the file
// viewer's, so the same path cannot open in two different viewers.
// ────────────────────────────────────────────────────────────────────────────

const RENDERER_TABLE: [string, ReturnType<typeof getFileCategory>, string][] = [
  ['/w/a.PNG', 'image', 'image'],
  ['/w/a.heic', 'image', 'image'],
  ['/w/a.pdf', 'pdf', 'pdf'],
  ['/w/a.docx', 'docx', 'docx'],
  ['/w/a.ppt', 'pptx', 'pptx'],
  ['/w/a.xls', 'xlsx', 'xlsx'],
  ['/w/a.tsv', 'csv', 'csv'],
  ['/w/a.ogv', 'video', 'video'],
  ['/w/a.opus', 'audio', 'audio'],
  ['/w/index.HTM', 'html', 'html-file'],
  ['/w/app.sqlite', 'sqlite', 'file'],
  ['/w/bundle.zip', 'zip', 'file'],
  ['/w/flow.mmd', 'code', 'mermaid'],
  ['/w/notes.md', 'code', 'file'],
  ['/w/main.py', 'code', 'file'],
];

describe('getFileCategory and getShowFileCategory agree', () => {
  for (const [path, fileCategory, showCategory] of RENDERER_TABLE) {
    test(`${path} → ${fileCategory} / ${showCategory}`, () => {
      expect(getFileCategory(path)).toBe(fileCategory);
      expect(getShowFileCategory(path)).toBe(showCategory);
    });
  }
});
