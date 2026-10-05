import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';

// The issuer under test talks to a scripted STS; config is read at import, so set it first.
process.env.KORTIX_CAPTURE_S3_BUCKET = 'kortix-capture';
process.env.KORTIX_CAPTURE_S3_REGION = 'us-east-1';
process.env.KORTIX_CAPTURE_S3_ENDPOINT = 'http://127.0.0.1:9000';
process.env.KORTIX_CAPTURE_S3_FORCE_PATH_STYLE = 'true';
process.env.KORTIX_CAPTURE_STS_ROLE_ARN = 'arn:aws:iam::000000000000:role/kortix-capture-device';
const sent: Array<Record<string, unknown>> = [];
mock.module('@aws-sdk/client-sts', () => ({
  STSClient: class {
    async send(command: { input: Record<string, unknown> }) {
      sent.push(command.input);
      return { Credentials: { AccessKeyId: 'ASIASYNTHETIC', SecretAccessKey: 'synthetic-secret', SessionToken: 'synthetic-session', Expiration: new Date(1790848800000) } };
    }
  },
  AssumeRoleCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));
const { captureCredentialIssuer, deviceSessionPolicy } = await import('./credentials');

const PREFIX = 'orgs/11111111-1111-4111-8111-111111111111/projects/22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const schema = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../tests/fixtures/capture-format-v2/schemas/issuer-credentials.schema.json'), 'utf8'),
);

test('the issued credentials match the engine’s issuer-credentials schema and name the device’s folder', async () => {
  const issued = await captureCredentialIssuer()!.issue({ prefix: PREFIX, deviceId: DEVICE });
  const validate = new Ajv2020({ strict: false }).compile(schema);
  expect(validate(issued) ? null : validate.errors).toBeNull();
  expect(issued).toMatchObject({ bucket: 'kortix-capture', prefix: PREFIX, device_id: DEVICE, path_style: true, expires_at_ms: 1790848800000, endpoint: 'http://127.0.0.1:9000' });
  expect(sent[0]).toMatchObject({ RoleArn: process.env.KORTIX_CAPTURE_STS_ROLE_ARN, DurationSeconds: 3600 });
  expect(JSON.parse(String(sent[0]!.Policy))).toEqual(deviceSessionPolicy('kortix-capture', PREFIX, DEVICE));
});

test('the session policy reaches exactly one device folder (read, write, delete, multipart), the project policy.json, and a prefix-bound list', () => {
  const policy = deviceSessionPolicy('kortix-capture', PREFIX, DEVICE);
  const byId = Object.fromEntries(policy.Statement.map((s) => [s.Sid, s]));
  expect(byId.DeviceFolder!.Resource).toEqual([`arn:aws:s3:::kortix-capture/${PREFIX}/${DEVICE}/*`]);
  // capture-format.md "Credentials": the engine probes with PUT, HEAD, DELETE and
  // deletes a forgotten range's objects itself, so delete is part of the contract.
  expect(byId.DeviceFolder!.Action).toEqual(['s3:PutObject', 's3:GetObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts']);
  expect(byId.AccountPolicy).toMatchObject({ Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::kortix-capture/${PREFIX}/policy.json`] });
  // Without s3:ListBucket a missing key answers 403, not 404 (learnings 2026-09-14).
  expect(byId.ListDeviceFolder).toMatchObject({
    Action: ['s3:ListBucket'],
    Resource: ['arn:aws:s3:::kortix-capture'],
    Condition: { StringLike: { 's3:prefix': [`${PREFIX}/${DEVICE}/*`] } },
  });
  const flat = JSON.stringify(policy);
  // Delete reaches the device folder only: never the project policy.json or another device.
  expect(policy.Statement.filter((s) => s.Action.includes('s3:DeleteObject')).map((s) => s.Resource)).toEqual([[`arn:aws:s3:::kortix-capture/${PREFIX}/${DEVICE}/*`]]);
  expect(flat).not.toContain('DeleteObjects');
  expect(flat).not.toContain('"s3:*"');
  expect(flat).not.toContain(`${PREFIX}/*`);
});
