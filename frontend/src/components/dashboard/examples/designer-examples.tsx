'use client';

import React from 'react';
import { DocExampleCard } from './doc-example-card';
import {
  Image,
  Palette,
  Layout,
  Smartphone,
  Monitor,
  Package,
  Shirt,
  Home,
  ShoppingBag,
  Camera,
  Brush,
  Layers,
  Frame,
  Sparkles,
  Wand2,
} from 'lucide-react';

type DesignerExample = {
  title: string;
  subtitle: string;
  query: string;
  icon: React.ReactNode;
  designType: 'logo' | 'social' | 'web' | 'product' | 'marketing' | 'brand';
};

const designerExamples: DesignerExample[] = [
  {
    title: 'Logo Design',
    subtitle: 'Brand identity creation',
    query: 'Design a modern logo for {{company}} that represents {{values/industry}}, including variations for light/dark backgrounds, icon-only version, and usage guidelines',
    icon: <Sparkles />,
    designType: 'logo',
  },
  {
    title: 'Social Media Post',
    subtitle: 'Instagram & Facebook graphics',
    query: 'Create engaging social media graphics for {{campaign}} with consistent branding, optimized for Instagram feed, stories, and Facebook posts',
    icon: <Camera />,
    designType: 'social',
  },
  {
    title: 'Website Hero',
    subtitle: 'Landing page visuals',
    query: 'Design a stunning hero section for {{website}} with headline, call-to-action, background imagery, and responsive layout for desktop and mobile',
    icon: <Monitor />,
    designType: 'web',
  },
  {
    title: 'Product Mockup',
    subtitle: '3D product visualization',
    query: 'Create realistic product mockups for {{product}} showing different angles, colors, and contexts with professional lighting and shadows',
    icon: <Package />,
    designType: 'product',
  },
  {
    title: 'Marketing Banner',
    subtitle: 'Ad campaign graphics',
    query: 'Design eye-catching banner ads for {{campaign}} in multiple sizes (728x90, 300x250, 320x50) with consistent messaging and CTAs',
    icon: <Frame />,
    designType: 'marketing',
  },
  {
    title: 'Brand Guidelines',
    subtitle: 'Visual identity system',
    query: 'Develop comprehensive brand guidelines including color palette, typography, logo usage, imagery style, and application examples',
    icon: <Palette />,
    designType: 'brand',
  },
  {
    title: 'App UI Design',
    subtitle: 'Mobile interface screens',
    query: 'Design intuitive UI screens for {{app_name}} including onboarding, home screen, key features, with consistent design system and interactions',
    icon: <Smartphone />,
    designType: 'web',
  },
  {
    title: 'T-Shirt Design',
    subtitle: 'Apparel graphics',
    query: 'Create trendy t-shirt designs for {{theme/brand}} with front/back graphics, multiple colorways, and print-ready files',
    icon: <Shirt />,
    designType: 'product',
  },
  {
    title: 'Business Card',
    subtitle: 'Professional contact cards',
    query: 'Design modern business cards for {{company}} with front/back layout, contact details, QR code, and print specifications',
    icon: <Layout />,
    designType: 'brand',
  },
  {
    title: 'Interior Design',
    subtitle: 'Room visualization',
    query: 'Create interior design concepts for {{room_type}} with furniture placement, color schemes, lighting, and mood boards',
    icon: <Home />,
    designType: 'product',
  },
  {
    title: 'E-commerce Product',
    subtitle: 'Product listing images',
    query: 'Design product images for {{product}} including hero shot, lifestyle photos, detail views, and infographics for e-commerce listing',
    icon: <ShoppingBag />,
    designType: 'marketing',
  },
  {
    title: 'Photo Manipulation',
    subtitle: 'Creative photo editing',
    query: 'Edit and enhance photos for {{purpose}} with color correction, compositing, retouching, and artistic effects',
    icon: <Wand2 />,
    designType: 'social',
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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {displayedExamples.map((example, index) => (
            <DesignerExampleCard
              key={example.title}
              title={example.title}
              subtitle={example.subtitle}
              icon={example.icon}
              designType={example.designType}
              onClick={() => onSelectPrompt?.(example.query)}
              index={index}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// Custom card component for designer examples with image placeholders
interface DesignerExampleCardProps {
  title: string;
  subtitle: string;
  onClick: () => void;
  icon?: React.ReactNode;
  designType: 'logo' | 'social' | 'web' | 'product' | 'marketing' | 'brand';
  index?: number;
}

function DesignerExampleCard({
  title,
  subtitle,
  onClick,
  icon,
  designType,
  index = 0
}: DesignerExampleCardProps) {
  const renderDesignTemplate = () => {
    switch (designType) {
      case 'logo':
        return (
          <div className="h-full w-full flex items-center justify-center bg-gradient-to-br from-purple-100 to-pink-100 dark:from-purple-900/20 dark:to-pink-900/20 p-4">
            <div className="w-16 h-16 bg-white/50 dark:bg-gray-800/50 rounded-xl flex items-center justify-center shadow-sm">
              <Sparkles className="w-8 h-8 text-purple-500 dark:text-purple-400" />
            </div>
          </div>
        );
      
      case 'social':
        return (
          <div className="h-full w-full bg-gradient-to-br from-blue-100 to-cyan-100 dark:from-blue-900/20 dark:to-cyan-900/20 p-3">
            <div className="h-full w-full bg-white/50 dark:bg-gray-800/50 rounded-lg shadow-sm p-2 space-y-1">
              <div className="w-full h-12 bg-gray-200/50 dark:bg-gray-700/50 rounded animate-pulse" />
              <div className="flex gap-1">
                <div className="w-4 h-4 bg-gray-300/50 dark:bg-gray-600/50 rounded-full" />
                <div className="flex-1 h-2 bg-gray-200/50 dark:bg-gray-700/50 rounded" />
              </div>
            </div>
          </div>
        );
      
      case 'web':
        return (
          <div className="h-full w-full bg-gradient-to-br from-green-100 to-emerald-100 dark:from-green-900/20 dark:to-emerald-900/20 p-3">
            <div className="h-full w-full bg-white/50 dark:bg-gray-800/50 rounded shadow-sm overflow-hidden">
              <div className="h-2 bg-gray-200/50 dark:bg-gray-700/50 flex items-center gap-0.5 px-1">
                <div className="w-1 h-1 bg-red-400 rounded-full" />
                <div className="w-1 h-1 bg-yellow-400 rounded-full" />
                <div className="w-1 h-1 bg-green-400 rounded-full" />
              </div>
              <div className="p-2 space-y-1">
                <div className="w-full h-8 bg-gray-200/50 dark:bg-gray-700/50 rounded animate-pulse" />
                <div className="w-3/4 h-1 bg-gray-200/50 dark:bg-gray-700/50 rounded" />
              </div>
            </div>
          </div>
        );
      
      case 'product':
        return (
          <div className="h-full w-full bg-gradient-to-br from-orange-100 to-amber-100 dark:from-orange-900/20 dark:to-amber-900/20 p-4 flex items-center justify-center">
            <div className="w-14 h-14 bg-white/50 dark:bg-gray-800/50 rounded-lg shadow-md transform rotate-3">
              <div className="h-full w-full bg-gray-200/50 dark:bg-gray-700/50 rounded-lg animate-pulse" />
            </div>
          </div>
        );
      
      case 'marketing':
        return (
          <div className="h-full w-full bg-gradient-to-br from-red-100 to-rose-100 dark:from-red-900/20 dark:to-rose-900/20 p-3">
            <div className="h-full w-full grid grid-cols-2 gap-1">
              <div className="bg-white/50 dark:bg-gray-800/50 rounded p-1">
                <div className="h-full bg-gray-200/50 dark:bg-gray-700/50 rounded animate-pulse" />
              </div>
              <div className="bg-white/50 dark:bg-gray-800/50 rounded p-1">
                <div className="h-full bg-gray-200/50 dark:bg-gray-700/50 rounded animate-pulse" />
              </div>
            </div>
          </div>
        );
      
      case 'brand':
        return (
          <div className="h-full w-full bg-gradient-to-br from-indigo-100 to-purple-100 dark:from-indigo-900/20 dark:to-purple-900/20 p-3">
            <div className="h-full w-full space-y-1">
              <div className="flex gap-1">
                <div className="w-3 h-3 bg-indigo-300 dark:bg-indigo-700 rounded" />
                <div className="w-3 h-3 bg-purple-300 dark:bg-purple-700 rounded" />
                <div className="w-3 h-3 bg-pink-300 dark:bg-pink-700 rounded" />
              </div>
              <div className="flex-1 bg-white/50 dark:bg-gray-800/50 rounded p-2">
                <div className="space-y-1">
                  <div className="w-full h-1 bg-gray-200/50 dark:bg-gray-700/50 rounded" />
                  <div className="w-3/4 h-1 bg-gray-200/50 dark:bg-gray-700/50 rounded" />
                </div>
              </div>
            </div>
          </div>
        );
      
      default:
        return (
          <div className="h-full w-full bg-gradient-to-br from-gray-100 to-slate-100 dark:from-gray-900/20 dark:to-slate-900/20 p-4 flex items-center justify-center">
            <div className="w-full h-full bg-white/50 dark:bg-gray-800/50 rounded-lg animate-pulse" />
          </div>
        );
    }
  };

  return (
    <div
      onClick={onClick}
      className="group relative cursor-pointer rounded-xl border border-border/50 bg-muted-foreground/5 hover:bg-accent/5 transition-all duration-200 hover:border-primary/20 w-full max-w-[280px]"
    >
      <div className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          {icon && (
            <div className="flex-shrink-0 mt-0.5">
              {React.cloneElement(icon as React.ReactElement, { 
                className: "w-4 h-4 text-muted-foreground" 
              })}
            </div>
          )}
          <div className="flex-1 min-w-0 space-y-0.5">
            <h3 className="text-sm font-medium text-foreground truncate">
              {title}
            </h3>
            <p className="text-xs text-muted-foreground line-clamp-2">
              {subtitle}
            </p>
          </div>
        </div>
        
        {/* Image placeholder area */}
        <div className="relative rounded-lg overflow-hidden h-20 border border-border/40">
          {renderDesignTemplate()}
          
          {/* Hover overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-background/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center pb-2">
            <span className="text-[10px] font-medium text-primary">
              Design →
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
