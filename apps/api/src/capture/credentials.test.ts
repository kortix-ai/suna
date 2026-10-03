import { expect, test } from 'bun:test';
import { deviceSessionPolicy } from './credentials';

const PREFIX = 'orgs/11111111-1111-4111-8111-111111111111/projects/22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';

test('the session policy reaches exactly one device folder, the project policy.json, and a prefix-bound list', () => {
  const policy = deviceSessionPolicy('kortix-capture', PREFIX, DEVICE);
  const byId = Object.fromEntries(policy.Statement.map((s) => [s.Sid, s]));
  expect(byId.DeviceFolder!.Resource).toEqual([`arn:aws:s3:::kortix-capture/${PREFIX}/${DEVICE}/*`]);
  expect(byId.DeviceFolder!.Action).toEqual(['s3:PutObject', 's3:GetObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts']);
  expect(byId.ProjectPolicy).toMatchObject({ Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::kortix-capture/${PREFIX}/policy.json`] });
  // Without s3:ListBucket a missing key answers 403, not 404 (learnings 2026-09-14).
  expect(byId.ListDeviceFolder).toMatchObject({
    Action: ['s3:ListBucket'],
    Resource: ['arn:aws:s3:::kortix-capture'],
    Condition: { StringLike: { 's3:prefix': [`${PREFIX}/${DEVICE}/*`] } },
  });
  // No statement names another device, the project prefix as a whole, a delete, or a wildcard action.
  const flat = JSON.stringify(policy);
  expect(flat).not.toContain('DeleteObject');
  expect(flat).not.toContain('"s3:*"');
  expect(policy.Statement.every((s) => s.Effect === 'Allow')).toBe(true);
  expect(flat).not.toContain(`${PREFIX}/*`);
});
