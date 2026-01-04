const SENTRY_URL = new URL(
  process.env.NEXT_PUBLIC_SENTRY_DSN ?? 'https://example.com/abc',
);
const SENTRY_HOST = SENTRY_URL.hostname;
const SENTRY_PROJECT_ID = SENTRY_URL.pathname.split('/').pop();

export const POST = async (req: Request) => {
  try {
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) {
      return Response.json(
        { error: 'Sentry is not configured' },
        { status: 500 },
      );
    }

    const envelopeBytes = await req.arrayBuffer();
    const envelope = new TextDecoder().decode(envelopeBytes);
    const piece = envelope.split('\n')[0];
    const header = JSON.parse(piece) as { dsn: string };
    const dsn = new URL(header.dsn);
    const project_id = dsn.pathname.replace('/', '');

    if (dsn.hostname !== SENTRY_HOST) {
      throw new Error(`Invalid sentry hostname: ${dsn.hostname}`);
    }

    if (project_id !== SENTRY_PROJECT_ID) {
      throw new Error(`Invalid sentry project id: ${project_id}`);
    }

    const upstream_sentry_url = `https://${SENTRY_HOST}/api/${project_id}/envelope/`;
    const response = await fetch(upstream_sentry_url, {
      body: envelopeBytes,
      method: 'POST',
    });

    return response;
  } catch (e) {
    console.error('error tunneling to sentry', e);
    return Response.json(
      { error: 'error tunneling to sentry' },
      { status: 500 },
    );
  }
};
