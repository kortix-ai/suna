import { expect, test } from 'bun:test';
import { manifestKeysFromEvent } from './workers';

test('an S3 event notification yields its decoded manifest keys; other objects and test events yield none', () => {
  const body = JSON.stringify({
    Records: [
      { eventName: 'ObjectCreated:Put', s3: { object: { key: 'orgs/a/projects/p/d/2026/10/03/1000-7.manifest.json' } } },
      { eventName: 'ObjectCreated:Put', s3: { object: { key: 'orgs/a/projects/p/d/2026/10/03/1000-7.mp4' } } },
      { eventName: 'ObjectCreated:Put', s3: { object: { key: 'orgs/a/projects/p/d/2026/10/03/2000-a8+%281%29.manifest.json' } } },
    ],
  });
  expect(manifestKeysFromEvent(body)).toEqual([
    'orgs/a/projects/p/d/2026/10/03/1000-7.manifest.json',
    'orgs/a/projects/p/d/2026/10/03/2000-a8 (1).manifest.json',
  ]);
  expect(manifestKeysFromEvent(JSON.stringify({ Service: 'Amazon S3', Event: 's3:TestEvent' }))).toEqual([]);
  expect(manifestKeysFromEvent('not json')).toEqual([]);
});
