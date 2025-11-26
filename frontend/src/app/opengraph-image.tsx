import { headers } from 'next/headers';
import { ImageResponse } from 'next/og';

// Configuration exports
export const runtime = 'edge';
export const alt = 'Kortix';
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = 'image/png';

export default async function Image() {
  try {
    return new ImageResponse(
      (
        <div
          style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, #000 0%, #1a1a1a 100%)',
            fontSize: 60,
            fontWeight: 700,
            color: 'white',
            padding: '80px',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              gap: '20px',
            }}
          >
            <div style={{ fontSize: 72, fontWeight: 800 }}>
              Kortix
            </div>
            <div style={{ fontSize: 36, fontWeight: 400, opacity: 0.9 }}>
              Your Autonomous AI Worker
            </div>
            <div style={{ fontSize: 24, fontWeight: 300, opacity: 0.7, maxWidth: '800px' }}>
              Built for complex tasks, designed for everything
            </div>
          </div>
        </div>
      ),
      { ...size },
    );
  } catch (error) {
    console.error('Error generating OpenGraph image:', error);
    return new Response(`Failed to generate image`, { status: 500 });
  }
}
