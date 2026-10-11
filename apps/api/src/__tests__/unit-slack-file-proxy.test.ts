import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ChannelOwnership } from '../connectors/channel-read-scope';

mock.module('../channels/install-store', () => ({
  loadSlackTokenForProject: async () => 'xoxb-test',
}));

const { downloadSlackFile } = await import('../channels/slack/file-proxy');
const { MAX_DOWNLOAD_BYTES } = await import('../channels/core/download');

// `slack download` reached any file the workspace's bot token could read: one
// Slack workspace shared by several Kortix projects let one project's agent
// download a file posted in another project's channel. The proxy now confines
// a download like a `file_info` read: the file must be shared in a
// conversation this project may read.
const FILE_URL = 'https://files.slack.com/files-pri/T0SYNTH01-F0SYNTH01/download/report.pdf';

/** A workspace shared with another project; channel C0MINE is ours, C0OTHER theirs. */
const ownership: ChannelOwnership = {
  installs: async () => ({ workspaceIds: ['T0SYNTH01'], shared: true }),
  channelProjects: async (_platform, _workspaces, ids) =>
    new Map(
      ids.flatMap((id) =>
        id === 'C0MINE' ? [[id, new Set(['proj-1'])]] : id === 'C0OTHER' ? [[id, new Set(['proj-2'])]] : [],
      ),
    ),
  threadOwners: async () => new Map(),
};

let sharedIn: string[] = ['C0MINE'];
let body: Uint8Array = new Uint8Array(8);
let lengthHeader = true;
let fetches: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  sharedIn = ['C0MINE'];
  body = new Uint8Array(8);
  lengthHeader = true;
  fetches = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    fetches.push(url);
    if (url === 'https://slack.com/api/files.info') {
      return Response.json({ ok: true, file: { id: 'F0SYNTH01', channels: sharedIn, groups: [], ims: [] } });
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      { headers: { 'content-type': 'application/pdf', ...(lengthHeader ? { 'content-length': String(body.byteLength) } : {}) } },
    );
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('downloadSlackFile confinement', () => {
  test('a file shared in this project’s channel downloads', async () => {
    const r = await downloadSlackFile('proj-1', FILE_URL, ownership);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.byteLength).toBe(8);
    expect(fetches).toEqual(['https://slack.com/api/files.info', FILE_URL]);
  });

  test('a file shared only in another project’s channel is refused 403 and never fetched', async () => {
    sharedIn = ['C0OTHER'];
    const r = await downloadSlackFile('proj-1', FILE_URL, ownership);
    expect(r).toEqual({
      ok: false,
      status: 403,
      error: 'Slack file F0SYNTH01 belongs to another Kortix project. This project\'s Slack connector reads only its own conversations.',
    });
    expect(fetches).toEqual(['https://slack.com/api/files.info']);
  });

  test('a thumbnail URL is confined by the file it belongs to', async () => {
    sharedIn = ['C0OTHER'];
    const thumb = 'https://files.slack.com/files-tmb/T0SYNTH01-F0SYNTH01-9a8b7c/report_360.png';
    const r = await downloadSlackFile('proj-1', thumb, ownership);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  test('a files.slack.com URL that names no file is refused 400 before any Slack call', async () => {
    for (const url of [
      'https://files.slack.com/files-pri/T0SYNTH01-F0SYNTH01',
      'https://files.slack.com/anything/else',
      'https://files.slack.com/files-pri/T0SYNTH01-F0SYNTH01/a/b/c.pdf',
    ]) {
      const r = await downloadSlackFile('proj-1', url, ownership);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
    expect(fetches).toEqual([]);
  });
});

describe('downloadSlackFile size limit', () => {
  test('a file whose Content-Length is past the limit is refused 413', async () => {
    body = new Uint8Array(MAX_DOWNLOAD_BYTES + 1);
    const r = await downloadSlackFile('proj-1', FILE_URL, ownership);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });

  test('a file with no Content-Length stops reading at the limit', async () => {
    body = new Uint8Array(MAX_DOWNLOAD_BYTES + 1);
    lengthHeader = false;
    const r = await downloadSlackFile('proj-1', FILE_URL, ownership);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });
});
