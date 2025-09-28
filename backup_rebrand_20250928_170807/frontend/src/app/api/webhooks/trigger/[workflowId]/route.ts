import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await params;
    
    console.log(`[Webhook Proxy] Received webhook for workflow: ${workflowId}`);
    
    const body = await request.arrayBuffer();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      if (!['host', 'content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        headers[key] = value;
      }
    });
    
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:8000';
    const targetUrl = `${backendUrl}/api/webhooks/trigger/${workflowId}`;
    
    console.log(`[Webhook Proxy] Backend URL: ${backendUrl}`);
    console.log(`[Webhook Proxy] Target URL: ${targetUrl}`);
    console.log(`[Webhook Proxy] Headers to forward:`, Object.keys(headers));
    console.log(`[Webhook Proxy] Body size:`, body.byteLength);

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: body,
    });
    
    console.log(`[Webhook Proxy] Backend response status: ${response.status}`);
    console.log(`[Webhook Proxy] Backend response ok: ${response.ok}`);

    const responseData = await response.text();
    console.log(`[Webhook Proxy] Backend response data:`, responseData);
    
    return new NextResponse(responseData, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
      },
    });

  } catch (error) {
    console.error('[Webhook Proxy] Error occurred:', error);
    console.error('[Webhook Proxy] Error details:', {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : 'Unknown error',
      cause: error instanceof Error ? error.cause : undefined,
    });
    
    return NextResponse.json(
      { 
        error: 'Internal server error', 
        details: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString() 
      },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await params;
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:8000';
    
    const response = await fetch(`${backendUrl}/api/webhooks/test/${workflowId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const responseData = await response.json();
    
    return NextResponse.json(responseData, { status: response.status });

  } catch (error) {
    console.error('Webhook test proxy error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
} 