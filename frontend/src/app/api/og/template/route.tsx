import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const shareId = searchParams.get('shareId');

    if (!shareId) {
      return new Response('Missing shareId parameter', { status: 400 });
    }

    const templateResponse = await fetch(
      `${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'}/api/templates/public/${shareId}`
    );

    if (!templateResponse.ok) {
      throw new Error('Template not found');
    }

    const template = await templateResponse.json();
    return new ImageResponse(
      (
        <div
          style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#0a0a0a',
            backgroundImage: 'linear-gradient(to bottom right, #1e1b4b, #0a0a0a)',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundImage: `radial-gradient(circle at 1px 1px, #ffffff10 1px, transparent 1px)`,
              backgroundSize: '40px 40px',
            }}
          />
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '60px',
              textAlign: 'center',
            }}
          >
            {template.is_kortix_team && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  backgroundColor: '#3b82f620',
                  borderRadius: '9999px',
                  padding: '8px 16px',
                  marginBottom: '24px',
                  border: '1px solid #3b82f640',
                }}
              >
                <span style={{ color: '#93c5fd', fontSize: '14px', fontWeight: 600 }}>
                  ✨ Official Template
                </span>
              </div>
            )}
            <div
              style={{
                width: '120px',
                height: '120px',
                borderRadius: '24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '64px',
                marginBottom: '32px',
              }}
            >
              🤖
            </div>
            <h1
              style={{
                fontSize: '56px',
                fontWeight: 700,
                color: '#ffffff',
                marginBottom: '16px',
                lineHeight: 1.1,
                maxWidth: '900px',
              }}
            >
              {template.name}
            </h1>
            <p
              style={{
                fontSize: '24px',
                color: '#94a3b8',
                marginBottom: '40px',
                maxWidth: '800px',
                lineHeight: 1.4,
              }}
            >
              {template.description || 'An AI agent template ready to be customized for your needs.'}
            </p>
            <div
              style={{
                display: 'flex',
                gap: '40px',
                alignItems: 'center',
                marginBottom: '40px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: '#64748b', fontSize: '18px' }}>by</span>
                <span style={{ color: '#e2e8f0', fontSize: '18px', fontWeight: 600 }}>
                  {template.creator_name || 'Anonymous'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: '#e2e8f0', fontSize: '18px', fontWeight: 600 }}>
                  {template.download_count}
                </span>
                <span style={{ color: '#64748b', fontSize: '18px' }}>installs</span>
              </div>
              {template.mcp_requirements && template.mcp_requirements.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ color: '#e2e8f0', fontSize: '18px', fontWeight: 600 }}>
                    {template.mcp_requirements.length}
                  </span>
                  <span style={{ color: '#64748b', fontSize: '18px' }}>integrations</span>
                </div>
              )}
            </div>
            {template.tags && template.tags.length > 0 && (
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '40px' }}>
                {template.tags.slice(0, 5).map((tag: string, index: number) => (
                  <div
                    key={index}
                    style={{
                      backgroundColor: '#1e293b',
                      borderRadius: '8px',
                      padding: '6px 12px',
                      fontSize: '16px',
                      color: '#94a3b8',
                      border: '1px solid #334155',
                    }}
                  >
                    {tag}
                  </div>
                ))}
              </div>
            )}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '16px',
                position: 'absolute',
                bottom: '40px',
              }}
            >
              <span style={{ color: '#64748b', fontSize: '20px' }}>Kortix Suna</span>
              <span style={{ color: '#334155', fontSize: '20px' }}>•</span>
              <span style={{ color: '#64748b', fontSize: '20px' }}>AI Agent Marketplace</span>
            </div>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
      }
    );
  } catch (error) {
    console.error('OG Image generation error:', error);
    return new ImageResponse(
      (
        <div
          style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#0a0a0a',
            backgroundImage: 'linear-gradient(to bottom right, #1e1b4b, #0a0a0a)',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontSize: '80px',
                marginBottom: '24px',
              }}
            >
              🤖
            </div>
            <h1
              style={{
                fontSize: '48px',
                fontWeight: 700,
                color: '#ffffff',
                marginBottom: '16px',
              }}
            >
              AI Agent Template
            </h1>
            <p
              style={{
                fontSize: '20px',
                color: '#94a3b8',
              }}
            >
              Discover powerful AI agents on Kortix Suna
            </p>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
      }
    );
  }
} 