import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  completeAgentKnowledgeUpload,
  createAgentKnowledgeSource,
  createAgentKnowledgeUpload,
  discardAgentProfileDraft,
  generateAgentProfileSkill,
  getAgentProfile,
  importAgentProfileSkillArchive,
  importAgentProfileSkillFromGitHub,
  installAgentProfileMarketplaceSkill,
  listAgentKnowledgeSources,
  pauseAgentProfileAutomation,
  previewAgentProfile,
  publishAgentProfile,
  revokeAgentKnowledgeSource,
  syncAgentKnowledgeSource,
  testAgentProfileDraft,
  updateAgentProfileDraft,
  uploadAgentKnowledgeFile,
} from './agent-profile';

let calls: Array<{ url: string; method: string; body: unknown }> = [];
let nextBody: unknown = { ok: true };

beforeEach(() => {
  calls = [];
  nextBody = { ok: true };
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: options.body ? JSON.parse(String(options.body)) : undefined,
    });
    return new Response(JSON.stringify(nextBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({
  backendUrl: 'http://test.local',
  getToken: async () => 'token',
});

describe('agent profile draft contract', () => {
  test('reads the unified profile', async () => {
    nextBody = { project_id: 'p1', agent_name: 'support', revision: 3 };
    await getAgentProfile('p1', 'support');
    expect(calls[0]).toMatchObject({
      url: 'http://test.local/projects/p1/agents/support/profile',
      method: 'GET',
    });
  });

  test('requires expectedRevision and sends the edited sections', async () => {
    await updateAgentProfileDraft('p1', 'support', {
      expectedRevision: 3,
      sections: {
        instructions: { prompt: 'Answer from approved sources.' },
        knowledge: ['support-handbook'],
      },
    });
    expect(calls[0]).toMatchObject({
      url: 'http://test.local/projects/p1/agents/support/profile/draft',
      method: 'PUT',
      body: {
        expectedRevision: 3,
        sections: {
          instructions: { prompt: 'Answer from approved sources.' },
          knowledge: ['support-handbook'],
        },
      },
    });
  });

  test('maps preview, test, publish, and discard to dedicated actions', async () => {
    await previewAgentProfile('p1', 'support');
    await testAgentProfileDraft('p1', 'support', {
      expectedRevision: 4,
      includePendingWriteIntegrations: false,
    });
    await publishAgentProfile('p1', 'support', {
      expectedRevision: 4,
      acknowledgeHighRisk: true,
    });
    await discardAgentProfileDraft('p1', 'support', { expectedRevision: 4 });

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'http://test.local/projects/p1/agents/support/profile/preview'],
      ['POST', 'http://test.local/projects/p1/agents/support/profile/test'],
      ['POST', 'http://test.local/projects/p1/agents/support/profile/publish'],
      ['POST', 'http://test.local/projects/p1/agents/support/profile/discard'],
    ]);
  });

  test('pauses an automation through the runtime-only safety action', async () => {
    await pauseAgentProfileAutomation('p1', 'support', 'weekday-briefing');

    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://test.local/projects/p1/agents/support/profile/automations/weekday-briefing/pause',
      body: {},
    });
  });
});

describe('agent knowledge management contract', () => {
  test('maps list, source creation, upload completion, sync, and immediate revoke', async () => {
    await listAgentKnowledgeSources('p1', 'support');
    await createAgentKnowledgeSource('p1', 'support', {
      type: 'url',
      title: 'Support handbook',
      url: 'https://docs.example.com/support',
    });
    await createAgentKnowledgeSource('p1', 'support', {
      type: 'connector',
      title: 'Drive handbook',
      connectorProfileId: 'profile-1',
      resourceId: 'file-1',
      connectorAction: 'files.get',
      resourceArgument: 'file_id',
    });
    await createAgentKnowledgeUpload('p1', 'support', {
      fileName: 'handbook.pdf',
      contentType: 'application/pdf',
      size: 1024,
    });
    await completeAgentKnowledgeUpload('p1', 'support', 'source-1', {
      uploadToken: 'upload-token',
    });
    await syncAgentKnowledgeSource('p1', 'support', 'source-1');
    await revokeAgentKnowledgeSource('p1', 'support', 'source-1');

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', 'http://test.local/projects/p1/agents/support/knowledge'],
      ['POST', 'http://test.local/projects/p1/agents/support/knowledge/sources'],
      ['POST', 'http://test.local/projects/p1/agents/support/knowledge/sources'],
      ['POST', 'http://test.local/projects/p1/agents/support/knowledge/uploads'],
      ['POST', 'http://test.local/projects/p1/agents/support/knowledge/source-1/complete'],
      ['POST', 'http://test.local/projects/p1/agents/support/knowledge/source-1/sync'],
      ['DELETE', 'http://test.local/projects/p1/agents/support/knowledge/source-1'],
    ]);
    expect(calls[2]?.body).toEqual({
      type: 'connector',
      title: 'Drive handbook',
      connectorProfileId: 'profile-1',
      resourceId: 'file-1',
      connectorAction: 'files.get',
      resourceArgument: 'file_id',
    });
  });

  test('uploads file bytes through the signed storage URL before completing the source', async () => {
    let call = 0;
    globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
      call += 1;
      calls.push({
        url: String(url),
        method: options.method ?? 'GET',
        body: options.body instanceof FormData ? options.body : undefined,
      });
      if (call === 1) {
        return Response.json({
          source: { source_id: 'source-upload' },
          signed_upload_url: 'https://storage.test/upload?token=signed',
          upload_token: 'signed',
          storage_path: 'account/project/support/source-upload/handbook.txt',
          expires_at: '2026-08-01T02:00:00.000Z',
        });
      }
      if (call === 2) return Response.json({ Key: 'uploaded' });
      return Response.json({ source_id: 'source-upload', status: 'pending' });
    }) as unknown as typeof fetch;

    const result = await uploadAgentKnowledgeFile('p1', 'support', {
      fileName: 'handbook.txt',
      contentType: 'text/plain',
      data: new Blob(['approved answers'], { type: 'text/plain' }),
    });

    expect(result).toMatchObject({
      source_id: 'source-upload',
      status: 'pending',
    });
    expect(calls.map((entry) => [entry.method, entry.url])).toEqual([
      ['POST', 'http://test.local/projects/p1/agents/support/knowledge/uploads'],
      ['PUT', 'https://storage.test/upload?token=signed'],
      ['POST', 'http://test.local/projects/p1/agents/support/knowledge/source-upload/complete'],
    ]);
    expect(calls[1]?.body).toBeInstanceOf(FormData);
  });
});

describe('agent profile skill management contract', () => {
  test('maps archive, marketplace, GitHub, and brief creation to typed staging actions', async () => {
    await importAgentProfileSkillArchive('p1', 'support', {
      fileName: 'triage.skill',
      dataBase64: 'UEsDBA==',
    });
    await installAgentProfileMarketplaceSkill('p1', 'support', {
      itemId: 'kortix:triage',
    });
    await importAgentProfileSkillFromGitHub('p1', 'support', {
      url: 'https://github.com/acme/skills/tree/main/triage',
    });
    await generateAgentProfileSkill('p1', 'support', {
      name: 'triage',
      brief: 'Triage new requests consistently.',
    });

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'http://test.local/projects/p1/agents/support/profile/skills/import'],
      ['POST', 'http://test.local/projects/p1/agents/support/profile/skills/marketplace'],
      ['POST', 'http://test.local/projects/p1/agents/support/profile/skills/github'],
      ['POST', 'http://test.local/projects/p1/agents/support/profile/skills/generate'],
    ]);
  });
});
