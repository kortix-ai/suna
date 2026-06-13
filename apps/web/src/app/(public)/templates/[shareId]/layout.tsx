import { Metadata } from 'next';
import { getServerPublicEnv } from '@/lib/public-env-server';

export async function generateMetadata({ params }: { params: Promise<{ shareId: string }> }): Promise<Metadata> {
  const { shareId: templateId } = await params;
  const runtimeEnv = getServerPublicEnv();
  const appUrl = runtimeEnv.APP_URL;

  try {
    const response = await fetch(`${runtimeEnv.BACKEND_URL}/templates/public/${templateId}`);

    if (!response.ok) {
      throw new Error('Template not found');
    }

    const template = await response.json();

    const title = `${template.name} - AI Worker Template | Kortix`;
    const description = template.description || 'Discover and install this AI worker template to enhance your workflow with powerful automation capabilities.';

    const ogImage = `${appUrl}/api/og/template?shareId=${templateId}`;

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        type: 'website',
        url: `${appUrl}/templates/${templateId}`,
        images: [
          {
            url: ogImage,
            width: 1200,
            height: 630,
            alt: template.name,
          }
        ],
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: [ogImage],
      },
    };
  } catch (error) {
    return {
      title: 'AI Worker Template | Kortix',
      description: 'Discover and install AI worker templates to enhance your workflow with powerful automation capabilities.',
      openGraph: {
        title: 'AI Worker Template | Kortix',
        description: 'Discover and install AI worker templates to enhance your workflow with powerful automation capabilities.',
        type: 'website',
        url: `${appUrl}/templates/${templateId}`,
        images: [
          {
            url: `${appUrl}/share-page/og-fallback.png`,
            width: 1200,
            height: 630,
            alt: 'Kortix AI Worker Template',
          }
        ],
      },
    };
  }
}

export default function TemplateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
} 
