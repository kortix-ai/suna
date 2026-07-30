import { describe, expect, test } from 'bun:test';

const runtimeSource = await Bun.file(
  new URL('../channels/voice/runtime.ts', import.meta.url).pathname,
).text();
const livekitSource = await Bun.file(
  new URL('../channels/voice/livekit.ts', import.meta.url).pathname,
).text();

describe('LiveKit voice metadata boundaries', () => {
  test('keeps the call-scoped bearer out of public room metadata', () => {
    const roomMetadataInterface = runtimeSource.match(
      /export interface VoiceRoomMetadata \{[\s\S]*?\n\}/,
    )?.[0];
    const workerMetadataInterface = runtimeSource.match(
      /export interface VoiceWorkerMetadata extends VoiceRoomMetadata \{[\s\S]*?\n\}/,
    )?.[0];

    expect(roomMetadataInterface).toBeDefined();
    expect(roomMetadataInterface).not.toContain('kortix_api_token');
    expect(workerMetadataInterface).toContain('kortix_api_token');
  });

  test('passes separate public room and private dispatch metadata', () => {
    expect(livekitSource).toContain('metadata: roomMetadata');
    expect(livekitSource).toContain('{ metadata: dispatchMetadata }');
    expect(livekitSource).not.toContain('{ metadata: roomMetadata }');
  });
});
