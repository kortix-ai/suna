'use client';

import React from 'react';

type DesignerExample = {
  title: string;
  subtitle: string;
  query: string;
  imageUrl: string;
};

const designerExamples: DesignerExample[] = [
  {
    title: 'Logo Design',
    subtitle: 'Brand identity creation',
    query: 'Design a modern logo for {{company}} that represents {{values/industry}}, including variations for light/dark backgrounds, icon-only version, and usage guidelines',
    imageUrl: 'https://images.unsplash.com/photo-1626785774573-4b799315345d?w=400&h=300&fit=crop',
  },
  {
    title: 'Social Media Post',
    subtitle: 'Instagram & Facebook graphics',
    query: 'Create engaging social media graphics for {{campaign}} with consistent branding, optimized for Instagram feed, stories, and Facebook posts',
    imageUrl: 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=400&h=300&fit=crop',
  },
  {
    title: 'Website Hero',
    subtitle: 'Landing page visuals',
    query: 'Design a stunning hero section for {{website}} with headline, call-to-action, background imagery, and responsive layout for desktop and mobile',
    imageUrl: 'https://images.unsplash.com/photo-1467232004584-a241de8bcf5d?w=400&h=300&fit=crop',
  },
  {
    title: 'Product Mockup',
    subtitle: '3D product visualization',
    query: 'Create realistic product mockups for {{product}} showing different angles, colors, and contexts with professional lighting and shadows',
    imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400&h=300&fit=crop',
  },
  {
    title: 'Marketing Banner',
    subtitle: 'Ad campaign graphics',
    query: 'Design eye-catching banner ads for {{campaign}} in multiple sizes (728x90, 300x250, 320x50) with consistent messaging and CTAs',
    imageUrl: 'https://images.unsplash.com/photo-1558655146-d09347e92766?w=400&h=300&fit=crop',
  },
  {
    title: 'Brand Guidelines',
    subtitle: 'Visual identity system',
    query: 'Develop comprehensive brand guidelines including color palette, typography, logo usage, imagery style, and application examples',
    imageUrl: 'https://images.unsplash.com/photo-1524634126442-357e0eac3c14?w=400&h=300&fit=crop',
  },
  {
    title: 'App UI Design',
    subtitle: 'Mobile interface screens',
    query: 'Design intuitive UI screens for {{app_name}} including onboarding, home screen, key features, with consistent design system and interactions',
    imageUrl: 'https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=400&h=300&fit=crop',
  },
  {
    title: 'T-Shirt Design',
    subtitle: 'Apparel graphics',
    query: 'Create trendy t-shirt designs for {{theme/brand}} with front/back graphics, multiple colorways, and print-ready files',
    imageUrl: 'https://images.unsplash.com/photo-1503341504253-dff4815485f1?w=400&h=300&fit=crop',
  },
  {
    title: 'Business Card',
    subtitle: 'Professional contact cards',
    query: 'Design modern business cards for {{company}} with front/back layout, contact details, QR code, and print specifications',
    imageUrl: 'https://images.unsplash.com/photo-1520045892732-304bc3ac5d8e?w=400&h=300&fit=crop',
  },
  {
    title: 'Interior Design',
    subtitle: 'Room visualization',
    query: 'Create interior design concepts for {{room_type}} with furniture placement, color schemes, lighting, and mood boards',
    imageUrl: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&h=300&fit=crop',
  },
  {
    title: 'E-commerce Product',
    subtitle: 'Product listing images',
    query: 'Design product images for {{product}} including hero shot, lifestyle photos, detail views, and infographics for e-commerce listing',
    imageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400&h=300&fit=crop',
  },
  {
    title: 'Photo Manipulation',
    subtitle: 'Creative photo editing',
    query: 'Edit and enhance photos for {{purpose}} with color correction, compositing, retouching, and artistic effects',
    imageUrl: 'https://images.unsplash.com/photo-1561998338-13ad7883b20f?w=400&h=300&fit=crop',
  },
];

interface DesignerExamplesProps {
  onSelectPrompt?: (query: string) => void;
  count?: number;
}

export function DesignerExamples({ onSelectPrompt, count = 4 }: DesignerExamplesProps) {
  const [displayedExamples, setDisplayedExamples] = React.useState<DesignerExample[]>([]);

  React.useEffect(() => {
    const shuffled = [...designerExamples].sort(() => 0.5 - Math.random());
    setDisplayedExamples(shuffled.slice(0, count));
  }, [count]);

  return (
    <div className="w-full">
      <div className="flex justify-center">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 w-full max-w-4xl px-4 lg:px-0">
          {displayedExamples.map((example) => (
            <DesignerExampleCard
              key={example.title}
              title={example.title}
              subtitle={example.subtitle}
              imageUrl={example.imageUrl}
              onClick={() => onSelectPrompt?.(example.query)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface DesignerExampleCardProps {
  title: string;
  subtitle: string;
  onClick: () => void;
  imageUrl: string;
}

function DesignerExampleCard({
  title,
  subtitle,
  onClick,
  imageUrl
}: DesignerExampleCardProps) {
  return (
    <div
      onClick={onClick}
      className="group relative cursor-pointer rounded-xl overflow-hidden border border-border/50 hover:border-primary/30 transition-all duration-300 bg-background"
    >
      <div className="aspect-[4/3] overflow-hidden">
        <img 
          src={imageUrl} 
          alt={title}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          loading="lazy"
        />
      </div>
      
      <div className="p-3 bg-muted/30 group-hover:bg-muted/60 transition-all">
        <h3 className="text-sm font-medium text-foreground line-clamp-1">
          {title}
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
          {subtitle}
        </p>
      </div>
    </div>
  );
}
