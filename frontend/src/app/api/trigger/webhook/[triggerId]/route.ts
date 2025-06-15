import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  request: NextRequest,
  { params }: { params: { triggerId: string } }
) {
  try {
    const { triggerId } = params;
    
    if (!triggerId) {
      return NextResponse.json(
        { error: 'Trigger ID is required' },
        { status: 400 }
      );
    }

    // Get the webhook payload
    const body = await request.text();
    const headers = Object.fromEntries(request.headers.entries());

    // Forward the webhook to the backend triggers system
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || process.env.BACKEND_URL;
    
    if (!backendUrl) {
      console.error('Backend URL not configured');
      return NextResponse.json(
        { error: 'Backend URL not configured' },
        { status: 500 }
      );
    }

    const response = await fetch(`${backendUrl}/trigger/webhook/${triggerId}`, {
      method: 'POST',
      headers: {
        'Content-Type': headers['content-type'] || 'application/json',
        'X-Forwarded-For': request.headers.get('x-forwarded-for') || 'unknown',
        'User-Agent': headers['user-agent'] || 'webhook-proxy',
        // Forward original headers that might be useful
        ...(headers['x-webhook-signature'] && { 'X-Webhook-Signature': headers['x-webhook-signature'] }),
        ...(headers['x-webhook-secret'] && { 'X-Webhook-Secret': headers['x-webhook-secret'] }),
        ...(headers['x-trigger-secret'] && { 'X-Trigger-Secret': headers['x-trigger-secret'] }),
        ...(headers['x-github-event'] && { 'X-GitHub-Event': headers['x-github-event'] }),
        ...(headers['x-hub-signature'] && { 'X-Hub-Signature': headers['x-hub-signature'] }),
        ...(headers['x-hub-signature-256'] && { 'X-Hub-Signature-256': headers['x-hub-signature-256'] }),
      },
      body: body,
    });

    // Forward the response from the backend
    const responseData = await response.text();
    
    return new NextResponse(responseData, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'application/json',
      },
    });

  } catch (error) {
    console.error('Error handling webhook:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// Handle other HTTP methods with appropriate responses
export async function GET() {
  return NextResponse.json(
    { error: 'GET method not allowed for webhooks' },
    { status: 405 }
  );
}

export async function PUT() {
  return NextResponse.json(
    { error: 'PUT method not allowed for webhooks' },
    { status: 405 }
  );
}

export async function DELETE() {
  return NextResponse.json(
    { error: 'DELETE method not allowed for webhooks' },
    { status: 405 }
  );
} 