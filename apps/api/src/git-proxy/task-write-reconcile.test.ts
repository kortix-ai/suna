import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAdvertisedGitRef } from './git-ref-advertisement';
import {
  buildTaskGitWriteReconcileBody,
  taskGitWriteMutationIsSettled,
} from './task-write-reconcile-protocol';

const enc = new TextEncoder();
const oid = 'a'.repeat(40);
function pkt(value: string) {
  return `${(enc.encode(value).byteLength + 4).toString(16).padStart(4, '0')}${value}`;
}

test('parses the exact branch from a smart-HTTP advertisement', () => {
  const body = enc.encode(
    [
      pkt('# service=git-upload-pack\n'),
      '0000',
      pkt(`${oid} refs/heads/worker-1\0multi_ack thin-pack\n`),
      pkt(`${'b'.repeat(40)} refs/heads/main\n`),
      '0000',
    ].join(''),
  );
  expect(parseAdvertisedGitRef(body, 'refs/heads/worker-1')).toBe(oid);
  expect(parseAdvertisedGitRef(body, 'refs/heads/missing')).toBeNull();
});

test('rejects malformed advertisements instead of treating them as settlement', () => {
  expect(() => parseAdvertisedGitRef(enc.encode('ffffshort'), 'refs/heads/worker-1')).toThrow(
    'truncated',
  );
});

test('settles only after the intended update or an invalidated old CAS', () => {
  const update = { ref: 'refs/heads/worker-1', oldOid: '1'.repeat(40), newOid: '2'.repeat(40) };
  expect(taskGitWriteMutationIsSettled(update, update.oldOid)).toBe(false);
  expect(taskGitWriteMutationIsSettled(update, update.newOid)).toBe(true);
  expect(taskGitWriteMutationIsSettled(update, null)).toBe(true);
  expect(taskGitWriteMutationIsSettled(update, '3'.repeat(40))).toBe(true);

  const create = { ...update, oldOid: '0'.repeat(40) };
  expect(taskGitWriteMutationIsSettled(create, null)).toBe(false);
  expect(taskGitWriteMutationIsSettled(create, '3'.repeat(40))).toBe(true);
});

test('builds one internal empty-pack receive-pack update', () => {
  const update = { ref: 'refs/heads/worker-1', oldOid: '1'.repeat(40), newOid: '2'.repeat(40) };
  const body = new TextDecoder().decode(
    buildTaskGitWriteReconcileBody(update, update.oldOid, update.newOid),
  );
  const payload = `${update.oldOid} ${update.newOid} ${update.ref}\0report-status`;
  expect(
    body.startsWith(`${(payload.length + 4).toString(16).padStart(4, '0')}${payload}0000PACK`),
  ).toBe(true);
});

test('the internal empty-pack command fences a real bare Git ref', () => {
  const root = mkdtempSync(join(tmpdir(), 'kortix-git-reconcile-'));
  const bare = join(root, 'upstream.git');
  const work = join(root, 'work');
  const git = (args: string[], cwd = root, input?: Uint8Array) =>
    execFileSync('git', args, {
      cwd,
      input,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Kortix Test',
        GIT_AUTHOR_EMAIL: 'test@kortix.local',
        GIT_COMMITTER_NAME: 'Kortix Test',
        GIT_COMMITTER_EMAIL: 'test@kortix.local',
      },
    })
      .toString()
      .trim();
  try {
    git(['init', '--bare', bare]);
    git(['init', work]);
    git(['commit', '--allow-empty', '-m', 'old'], work);
    const oldOid = git(['rev-parse', 'HEAD'], work);
    git(['commit', '--allow-empty', '-m', 'new'], work);
    const newOid = git(['rev-parse', 'HEAD'], work);
    git(['push', bare, 'HEAD:refs/heads/seed'], work);
    git(['--git-dir', bare, 'update-ref', 'refs/heads/worker-1', oldOid]);

    const target = { ref: 'refs/heads/worker-1', oldOid, newOid };
    git(
      ['receive-pack', '--stateless-rpc', bare],
      root,
      buildTaskGitWriteReconcileBody(target, oldOid, newOid),
    );
    expect(git(['--git-dir', bare, 'rev-parse', target.ref])).toBe(newOid);

    git(
      ['receive-pack', '--stateless-rpc', bare],
      root,
      buildTaskGitWriteReconcileBody(target, newOid, '0'.repeat(40)),
    );
    expect(() => git(['--git-dir', bare, 'rev-parse', '--verify', target.ref])).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
