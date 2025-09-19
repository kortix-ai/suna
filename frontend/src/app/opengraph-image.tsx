import { headers } from 'next/headers';
import { ImageResponse } from 'next/og';

// Configuration exports
export const runtime = 'edge';
export const alt = 'Kortix Suna';
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = 'image/png';

export default async function Image() {
  try {
    // Get the host from headers
    const headersList = await headers();
    const host = headersList.get('host') || '';
    const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
    const baseUrl = `${protocol}://${host}`;

    return new ImageResponse(
      (
        <div
          style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'black',
          }}
        >
          <img
            src={`${baseUrl}/banner.png`}
            alt={alt}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
            }}
          />
        </div>
      ),
      { ...size },
    );
  } catch (error) {
    console.error('Error generating OpenGraph image:', error);
    return new Response(`Failed to generate image`, { status: 500 });
  }
}
