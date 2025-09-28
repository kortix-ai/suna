import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ triggerId: string }> }
) {
  try {
    const { triggerId } = await params;
    const body = await request.arrayBuffer();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      if (!['host', 'content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        headers[key] = value;
      }
    });
    
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:8000';
    const targetUrl = `${backendUrl}/triggers/${triggerId}/webhook`;
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': headers['content-type'] || 'application/json',
      },
      body: body,
    });

    const responseData = await response.text();
    
    return new NextResponse(responseData, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
      },
    });

  } catch (error) {
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
  { params }: { params: Promise<{ triggerId: string }> }
) {
  try {
    const { triggerId } = await params;
    return NextResponse.json({ 
      status: 'ok', 
      service: 'trigger-webhook-proxy',
      triggerId: triggerId 
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
} 