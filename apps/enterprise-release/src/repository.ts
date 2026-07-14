import { constants, createHash, verify as verifySignature } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import { canonicalize } from '@tufjs/canonical-json';

export interface TufKey {
  keytype: 'rsa';
  scheme: 'rsassa-pss-sha256';
  keyval: { public: string };
}

export interface TufSigner {
  keyId: string;
  key: TufKey;
  sign(data: Buffer): string;
}

interface Signature {
  keyid: string;
  sig: string;
}

export interface Envelope<T extends Record<string, unknown>> {
  signatures: Signature[];
  signed: T;
}

export interface TargetDescription {
  length: number;
  hashes: { sha256: string };
  custom?: Record<string, unknown>;
}

export interface RepositoryKeys {
  root: TufSigner[];
  targets: TufSigner;
  snapshot: TufSigner;
  timestamp: TufSigner;
}

export interface TargetInput {
  path: string;
  bytes: Buffer;
  custom?: Record<string, unknown>;
}

const SPEC_VERSION = '1.0.31';
const TIMESTAMP_EXPIRY_DAYS = 7;

export function keyIdFor(key: TufKey): string {
  return sha256(Buffer.from(canonicalize(key)));
}

export function bootstrapRepository(rootDir: string, keys: RepositoryKeys, now = new Date()): void {
  if (keys.root.length < 2) throw new Error('TUF root requires at least two independent signers');
  const all = [...keys.root, keys.targets, keys.snapshot, keys.timestamp];
  if (new Set(all.map((key) => key.keyId)).size !== all.length) throw new Error('every TUF role must use a distinct key');
  const rootSigned = {
    _type: 'root',
    spec_version: SPEC_VERSION,
    version: 1,
    expires: expires(now, 365),
    consistent_snapshot: true,
    keys: Object.fromEntries(all.map((signer) => [signer.keyId, signer.key])),
    roles: {
      root: { keyids: keys.root.map((key) => key.keyId), threshold: 2 },
      targets: { keyids: [keys.targets.keyId], threshold: 1 },
      snapshot: { keyids: [keys.snapshot.keyId], threshold: 1 },
      timestamp: { keyids: [keys.timestamp.keyId], threshold: 1 },
    },
  };
  const root = signEnvelope(rootSigned, keys.root);
  const targets = signEnvelope({
    _type: 'targets', spec_version: SPEC_VERSION, version: 1, expires: expires(now, 90), targets: {},
  }, [keys.targets]);
  const targetsBytes = serialize(targets);
  const snapshot = signEnvelope({
    _type: 'snapshot', spec_version: SPEC_VERSION, version: 1, expires: expires(now, 14),
    meta: { 'targets.json': metaFile(1, targetsBytes) },
  }, [keys.snapshot]);
  const snapshotBytes = serialize(snapshot);
  const timestamp = signEnvelope({
    _type: 'timestamp', spec_version: SPEC_VERSION, version: 1, expires: expires(now, TIMESTAMP_EXPIRY_DAYS),
    meta: { 'snapshot.json': metaFile(1, snapshotBytes) },
  }, [keys.timestamp]);

  writeMetadata(rootDir, '1.root.json', serialize(root));
  writeMetadata(rootDir, 'root.json', serialize(root));
  writeMetadata(rootDir, '1.targets.json', targetsBytes);
  writeMetadata(rootDir, 'targets.json', targetsBytes);
  writeMetadata(rootDir, '1.snapshot.json', snapshotBytes);
  writeMetadata(rootDir, 'snapshot.json', snapshotBytes);
  writeMetadata(rootDir, 'timestamp.json', serialize(timestamp));
}

export function publishTargets(
  rootDir: string,
  keys: Omit<RepositoryKeys, 'root'>,
  inputs: TargetInput[],
  trustedRootSha256: string,
  now = new Date(),
): { targetsVersion: number; snapshotVersion: number; timestampVersion: number } {
  const {
    root: currentRoot,
    targets: currentTargets,
    snapshot: currentSnapshot,
    timestamp: currentTimestamp,
  } = verifyRepository(
    rootDir,
    trustedRootSha256,
  );
  assertAuthorizedSigner(currentRoot.signed, 'targets', keys.targets);
  assertAuthorizedSigner(currentRoot.signed, 'snapshot', keys.snapshot);
  assertAuthorizedSigner(currentRoot.signed, 'timestamp', keys.timestamp);
  const targetsVersion = numberField(currentTargets.signed, 'version') + 1;
  const snapshotVersion = numberField(currentSnapshot.signed, 'version') + 1;
  const timestampVersion = numberField(currentTimestamp.signed, 'version') + 1;
  const existing = recordField(currentTargets.signed, 'targets') as Record<string, TargetDescription>;
  const targets = { ...existing };
  for (const input of inputs) {
    validateTargetPath(input.path);
    const description = targetDescription(input.bytes, input.custom);
    targets[input.path] = description;
    writeTarget(rootDir, consistentTargetPath(input.path, description.hashes.sha256), input.bytes);
    writeTarget(rootDir, input.path, input.bytes);
  }
  const targetsEnvelope = signEnvelope({
    _type: 'targets', spec_version: SPEC_VERSION, version: targetsVersion,
    expires: expires(now, 90), targets,
  }, [keys.targets]);
  const targetsBytes = serialize(targetsEnvelope);
  const snapshotEnvelope = signEnvelope({
    _type: 'snapshot', spec_version: SPEC_VERSION, version: snapshotVersion,
    expires: expires(now, 14), meta: { 'targets.json': metaFile(targetsVersion, targetsBytes) },
  }, [keys.snapshot]);
  const snapshotBytes = serialize(snapshotEnvelope);
  const timestampEnvelope = signEnvelope({
    _type: 'timestamp', spec_version: SPEC_VERSION, version: timestampVersion,
    expires: expires(now, TIMESTAMP_EXPIRY_DAYS), meta: { 'snapshot.json': metaFile(snapshotVersion, snapshotBytes) },
  }, [keys.timestamp]);

  writeMetadata(rootDir, `${targetsVersion}.targets.json`, targetsBytes);
  writeMetadata(rootDir, 'targets.json', targetsBytes);
  writeMetadata(rootDir, `${snapshotVersion}.snapshot.json`, snapshotBytes);
  writeMetadata(rootDir, 'snapshot.json', snapshotBytes);
  writeMetadata(rootDir, 'timestamp.json', serialize(timestampEnvelope));
  return { targetsVersion, snapshotVersion, timestampVersion };
}

export function refreshTimestamp(
  rootDir: string,
  signer: TufSigner,
  trustedRootSha256: string,
  now = new Date(),
): { timestampVersion: number; expires: string } {
  const repository = verifyRepository(rootDir, trustedRootSha256);
  assertAuthorizedSigner(repository.root.signed, 'timestamp', signer);
  const snapshotBytes = readMetadataBytes(rootDir, 'snapshot.json');
  const snapshotVersion = numberField(repository.snapshot.signed, 'version');
  const timestampVersion = numberField(repository.timestamp.signed, 'version') + 1;
  const expiration = expires(now, TIMESTAMP_EXPIRY_DAYS);
  const timestamp = signEnvelope({
    _type: 'timestamp',
    spec_version: SPEC_VERSION,
    version: timestampVersion,
    expires: expiration,
    meta: { 'snapshot.json': metaFile(snapshotVersion, snapshotBytes) },
  }, [signer]);
  writeMetadata(rootDir, 'timestamp.json', serialize(timestamp));
  return { timestampVersion, expires: expiration };
}

export function verifyRepository(rootDir: string, trustedRootSha256: string): {
  root: Envelope<Record<string, unknown>>;
  targets: Envelope<Record<string, unknown>>;
  snapshot: Envelope<Record<string, unknown>>;
  timestamp: Envelope<Record<string, unknown>>;
} {
  if (!/^[a-f0-9]{64}$/.test(trustedRootSha256)) throw new Error('trusted TUF root SHA-256 is invalid');
  const firstRootBytes = readMetadataBytes(rootDir, '1.root.json');
  if (sha256(firstRootBytes) !== trustedRootSha256) throw new Error('trusted TUF root SHA-256 does not match metadata/1.root.json');
  let trustedRoot = parseEnvelope(firstRootBytes, '1.root.json');
  assertMetadata(trustedRoot.signed, 'root', 1, '1.root.json');
  verifyRoleSignatures(trustedRoot, trustedRoot.signed, 'root', '1.root.json');

  const latestRootBytes = readMetadataBytes(rootDir, 'root.json');
  const advertisedRoot = parseEnvelope(latestRootBytes, 'root.json');
  assertMetadata(advertisedRoot.signed, 'root', undefined, 'root.json');
  const latestRootVersion = numberField(advertisedRoot.signed, 'version');
  if (latestRootVersion > 64) throw new Error('TUF root rotation chain exceeds the reviewed maximum of 64');

  for (let version = 2; version <= latestRootVersion; version += 1) {
    const name = `${version}.root.json`;
    const next = parseEnvelope(readMetadataBytes(rootDir, name), name);
    assertMetadata(next.signed, 'root', version, name);
    verifyRoleSignatures(next, trustedRoot.signed, 'root', `${name} with preceding root`);
    verifyRoleSignatures(next, next.signed, 'root', `${name} with new root`);
    trustedRoot = next;
  }
  const versionedLatestRoot = readMetadataBytes(rootDir, `${latestRootVersion}.root.json`);
  if (!latestRootBytes.equals(versionedLatestRoot)) throw new Error('root.json does not match its versioned root metadata');

  const targetsBytes = readMetadataBytes(rootDir, 'targets.json');
  const targets = parseEnvelope(targetsBytes, 'targets.json');
  assertMetadata(targets.signed, 'targets', undefined, 'targets.json');
  verifyRoleSignatures(targets, trustedRoot.signed, 'targets', 'targets.json');
  assertVersionedMetadataMatches(rootDir, targetsBytes, targets, 'targets');

  const snapshotBytes = readMetadataBytes(rootDir, 'snapshot.json');
  const snapshot = parseEnvelope(snapshotBytes, 'snapshot.json');
  assertMetadata(snapshot.signed, 'snapshot', undefined, 'snapshot.json');
  verifyRoleSignatures(snapshot, trustedRoot.signed, 'snapshot', 'snapshot.json');
  assertVersionedMetadataMatches(rootDir, snapshotBytes, snapshot, 'snapshot');
  assertMetaFile(snapshot.signed, 'targets.json', targetsBytes, numberField(targets.signed, 'version'));

  const timestampBytes = readMetadataBytes(rootDir, 'timestamp.json');
  const timestamp = parseEnvelope(timestampBytes, 'timestamp.json');
  assertMetadata(timestamp.signed, 'timestamp', undefined, 'timestamp.json');
  verifyRoleSignatures(timestamp, trustedRoot.signed, 'timestamp', 'timestamp.json');
  assertMetaFile(timestamp.signed, 'snapshot.json', snapshotBytes, numberField(snapshot.signed, 'version'));

  return { root: trustedRoot, targets, snapshot, timestamp };
}

export function signEnvelope<T extends Record<string, unknown>>(signed: T, signers: TufSigner[]): Envelope<T> {
  const bytes = Buffer.from(canonicalize(signed));
  return {
    signatures: signers.map((signer) => ({ keyid: signer.keyId, sig: signer.sign(bytes) })),
    signed,
  };
}

export function targetDescription(bytes: Buffer, custom?: Record<string, unknown>): TargetDescription {
  return { length: bytes.length, hashes: { sha256: sha256(bytes) }, ...(custom ? { custom } : {}) };
}

export function consistentTargetPath(path: string, digest: string): string {
  const directory = posix.dirname(path);
  const filename = `${digest}.${posix.basename(path)}`;
  return directory === '.' ? filename : `${directory}/${filename}`;
}

export function serialize(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function metaFile(version: number, bytes: Buffer) {
  return { version, length: bytes.length, hashes: { sha256: sha256(bytes) } };
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function expires(now: Date, days: number): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString().replace('.000Z', 'Z');
}

function writeMetadata(root: string, name: string, bytes: Buffer): void {
  const path = join(root, 'metadata', name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
}

function writeTarget(root: string, path: string, bytes: Buffer): void {
  const output = join(root, 'targets', ...path.split('/'));
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, bytes, { mode: 0o600 });
}

function parseEnvelope(bytes: Buffer, name: string): Envelope<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} is not a TUF envelope`);
  const envelope = value as Record<string, unknown>;
  if (!Array.isArray(envelope.signatures) || typeof envelope.signed !== 'object' || envelope.signed === null || Array.isArray(envelope.signed)) {
    throw new Error(`${name} is not a TUF envelope`);
  }
  return envelope as unknown as Envelope<Record<string, unknown>>;
}

function readMetadataBytes(root: string, name: string): Buffer {
  const path = join(root, 'metadata', name);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`unable to read TUF metadata ${name}: ${(error as Error).message}`);
  }
  if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024) throw new Error(`TUF metadata ${name} has an invalid size`);
  return bytes;
}

function assertMetadata(
  signed: Record<string, unknown>,
  type: 'root' | 'targets' | 'snapshot' | 'timestamp',
  expectedVersion: number | undefined,
  name: string,
): void {
  if (signed._type !== type || signed.spec_version !== SPEC_VERSION) throw new Error(`${name} has an invalid TUF type or spec version`);
  const version = numberField(signed, 'version');
  if (expectedVersion !== undefined && version !== expectedVersion) throw new Error(`${name} has version ${version}, expected ${expectedVersion}`);
}

function verifyRoleSignatures(
  envelope: Envelope<Record<string, unknown>>,
  root: Record<string, unknown>,
  roleName: 'root' | 'targets' | 'snapshot' | 'timestamp',
  label: string,
): void {
  const keys = recordField(root, 'keys');
  const roles = recordField(root, 'roles');
  const role = recordField(roles, roleName);
  const keyIds = role.keyids;
  const threshold = role.threshold;
  if (!Array.isArray(keyIds) || keyIds.some((key) => typeof key !== 'string') || !Number.isSafeInteger(threshold) || (threshold as number) < 1) {
    throw new Error(`TUF root role ${roleName} is invalid`);
  }
  const allowed = new Set(keyIds as string[]);
  const signedBytes = Buffer.from(canonicalize(envelope.signed));
  const verified = new Set<string>();
  for (const signature of envelope.signatures) {
    if (typeof signature?.keyid !== 'string' || typeof signature?.sig !== 'string' || !allowed.has(signature.keyid) || verified.has(signature.keyid)) continue;
    const keyValue = keys[signature.keyid];
    if (typeof keyValue !== 'object' || keyValue === null || Array.isArray(keyValue)) continue;
    const key = keyValue as Record<string, unknown>;
    const keyval = key.keyval;
    if (key.keytype !== 'rsa' || key.scheme !== 'rsassa-pss-sha256' || typeof keyval !== 'object' || keyval === null || Array.isArray(keyval)) continue;
    const publicKey = (keyval as Record<string, unknown>).public;
    if (typeof publicKey !== 'string' || !/^[a-f0-9]+$/.test(signature.sig) || signature.sig.length % 2 !== 0) continue;
    const valid = verifySignature('sha256', signedBytes, {
      key: publicKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, Buffer.from(signature.sig, 'hex'));
    if (valid) verified.add(signature.keyid);
  }
  if (verified.size < (threshold as number)) {
    throw new Error(`${label} does not satisfy the trusted ${roleName} signature threshold`);
  }
}

function assertAuthorizedSigner(
  root: Record<string, unknown>,
  roleName: 'targets' | 'snapshot' | 'timestamp',
  signer: TufSigner,
): void {
  const roles = recordField(root, 'roles');
  const role = recordField(roles, roleName);
  const keyIds = role.keyids;
  if (!Array.isArray(keyIds) || !keyIds.includes(signer.keyId)) {
    throw new Error(`configured ${roleName} signer is not authorized by the trusted TUF root`);
  }
  const keys = recordField(root, 'keys');
  const expected = keys[signer.keyId];
  if (canonicalize(expected) !== canonicalize(signer.key)) {
    throw new Error(`configured ${roleName} signer key does not match the trusted TUF root`);
  }
}

function assertVersionedMetadataMatches(
  root: string,
  unversioned: Buffer,
  envelope: Envelope<Record<string, unknown>>,
  role: 'targets' | 'snapshot',
): void {
  const version = numberField(envelope.signed, 'version');
  if (!unversioned.equals(readMetadataBytes(root, `${version}.${role}.json`))) {
    throw new Error(`${role}.json does not match its versioned metadata`);
  }
}

function assertMetaFile(
  signed: Record<string, unknown>,
  name: string,
  bytes: Buffer,
  expectedVersion: number,
): void {
  const meta = recordField(signed, 'meta');
  const entry = recordField(meta, name);
  const hashes = recordField(entry, 'hashes');
  if (entry.version !== expectedVersion || entry.length !== bytes.length || hashes.sha256 !== sha256(bytes)) {
    throw new Error(`TUF metadata chain does not authenticate ${name}`);
  }
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < 1) throw new Error(`metadata ${key} is invalid`);
  return field as number;
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (typeof field !== 'object' || field === null || Array.isArray(field)) throw new Error(`metadata ${key} is invalid`);
  return field as Record<string, unknown>;
}

function validateTargetPath(path: string): void {
  if (!/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path)) {
    throw new Error(`unsafe TUF target path: ${path}`);
  }
}
