import { describe, test, expect, mock } from 'bun:test';

mock.module('../config', () => ({
  config: {
    ENV_MODE: 'local',
    INTERNAL_KORTIX_ENV: 'staging',
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    KORTIX_URL: 'http://localhost:3000',
  },
}));

describe('CanvasFileArtifactMessage types', () => {
  test('CanvasFileArtifactMessage satisfies CanvasMessage union', async () => {
    const { FILE_ARTIFACT_ALLOWED_MIMES } = await import('../canvas/types');
    const msg = {
      type: 'canvas' as const,
      kind: 'file_artifact' as const,
      id: 'test-id',
      data: {
        filename: 'report.pdf',
        sandbox_path: '/workspace/report.pdf',
        sandbox_id: 'sb-abc',
        mime_type: 'application/pdf' as const,
        size_bytes: 142000,
        description: 'Monthly summary',
      },
    };
    expect(msg.kind).toBe('file_artifact');
    expect(msg.data.filename).toBe('report.pdf');
    expect(msg.data.size_bytes).toBe(142000);
    expect(FILE_ARTIFACT_ALLOWED_MIMES.has('application/pdf')).toBe(true);
    expect(FILE_ARTIFACT_ALLOWED_MIMES.has('text/csv')).toBe(true);
    expect(FILE_ARTIFACT_ALLOWED_MIMES.has('image/jpeg')).toBe(true);
    expect(FILE_ARTIFACT_ALLOWED_MIMES.has('application/octet-stream')).toBe(false);
  });

  test('canvas store stores and retrieves file_artifact events', async () => {
    const { storeCanvasEvent, getCanvasEvents, clearCanvasEvents } = await import('../canvas/store');
    const sessionId = 'test-session-artifact';

    const msg = {
      type: 'canvas' as const,
      kind: 'file_artifact' as const,
      id: 'evt-1',
      data: {
        filename: 'data.csv',
        sandbox_path: '/workspace/data.csv',
        sandbox_id: 'sb-xyz',
        mime_type: 'text/csv' as const,
        size_bytes: 5120,
      },
    };

    storeCanvasEvent(sessionId, msg);
    const events = getCanvasEvents(sessionId);
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe('file_artifact');
    // Narrow to file_artifact and check data
    if (events[0].kind === 'file_artifact') {
      expect(events[0].data.filename).toBe('data.csv');
      expect(events[0].data.size_bytes).toBe(5120);
      expect(events[0].data.sandbox_path).toBe('/workspace/data.csv');
    }

    clearCanvasEvents(sessionId);
    expect(getCanvasEvents(sessionId).length).toBe(0);
  });
});
