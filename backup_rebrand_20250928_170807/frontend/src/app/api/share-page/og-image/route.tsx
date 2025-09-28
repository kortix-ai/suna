import { NextResponse } from 'next/server';

// Add route segment config for caching
export const runtime = 'edge'; // Use edge runtime for better performance
export const revalidate = 3600; // Cache for 1 hour

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const title = searchParams.get('title');

  // Add error handling
  if (!title) {
    return new NextResponse('Missing title parameter', { status: 400 });
  }

  try {
    const response = await fetch(`https://api.orshot.com/v1/studio/render`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.ORSHOT_API_KEY}`,
      },
      body: JSON.stringify({
        templateId: 10,
        modifications: {
          title,
        },
        response: {
          type: 'binary',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Orshot API error: ${response.status}`);
    }

    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const image = Buffer.from(arrayBuffer);

    return new NextResponse(image, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      },
    });
  } catch (error) {
    console.error('OG Image generation error:', error);
    return new NextResponse('Error generating image', { status: 500 });
  }
}
