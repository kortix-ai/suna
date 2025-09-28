import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Palette, Layout, Sparkles, Building2, Brush } from 'lucide-react';
import { ToolViewProps } from '../types';
import { extractToolData } from '../utils';

interface ColorScheme {
  name: string;
  colors: {
    primary: string;
    accent: string;
    background: string;
  };
}

interface Template {
  name: string;
  description: string;
  layouts: string[];
  color_schemes: ColorScheme[];
}

interface TemplatesData {
  templates: Record<string, Template>;
}

const templateIcons = {
  minimal: Sparkles,
  corporate: Building2,
  creative: Brush,
};

const templateColors = {
  minimal: 'bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-800',
  corporate: 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-800',
  creative: 'bg-purple-50 border-purple-200 dark:bg-purple-950/30 dark:border-purple-800',
};

const templateAccents = {
  minimal: 'text-blue-600 dark:text-blue-400',
  corporate: 'text-emerald-600 dark:text-emerald-400',
  creative: 'text-purple-600 dark:text-purple-400',
};

export function ListPresentationTemplatesToolView({ toolContent }: ToolViewProps) {
  const { toolResult } = extractToolData(toolContent);
  
  let templatesData: TemplatesData | null = null;
  let error: string | null = null;

  try {
    if (toolResult && toolResult.toolOutput && toolResult.toolOutput !== 'STREAMING') {
      const output = toolResult.toolOutput;
      if (typeof output === 'string') {
        try {
          templatesData = JSON.parse(output);
        } catch (e) {
          console.error('Failed to parse tool output:', e);
          error = 'Failed to parse templates data';
        }
      } else {
        templatesData = output as unknown as TemplatesData;
      }
    }
  } catch (e) {
    console.error('Error processing tool result:', e);
    error = 'Error processing templates data';
  }

  if (!templatesData || !templatesData.templates || error) {
    return (
      <div className="text-center p-8">
        <Palette className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <p className="text-muted-foreground">
          {error || 'No template data available'}
        </p>
      </div>
    );
  }

  const templates = templatesData.templates;

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <div className="flex items-center justify-center gap-2 text-2xl font-bold">
          <Palette className="h-8 w-8 text-primary" />
          Premium Presentation Templates
        </div>
        <p className="text-muted-foreground">
          Professional hardcoded templates ensuring uniformity and minimalism
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-1 lg:grid-cols-3">
        {Object.entries(templates).map(([key, template]) => {
          const IconComponent = templateIcons[key as keyof typeof templateIcons] || Sparkles;
          const cardClass = templateColors[key as keyof typeof templateColors] || templateColors.minimal;
          const accentClass = templateAccents[key as keyof typeof templateAccents] || templateAccents.minimal;

          return (
            <Card key={key} className={`transition-all duration-300 hover:shadow-lg ${cardClass}`}>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg bg-white/60 dark:bg-gray-800/60`}>
                    <IconComponent className={`h-6 w-6 ${accentClass}`} />
                  </div>
                  <div>
                    <CardTitle className="text-xl capitalize">{template.name}</CardTitle>
                    <CardDescription className="text-sm mt-1">
                      {template.description}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                {/* Layouts */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Layout className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Available Layouts</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {template.layouts.map((layout) => (
                      <Badge 
                        key={layout} 
                        variant="secondary" 
                        className="text-xs px-2 py-1"
                      >
                        {layout}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Color Schemes */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Palette className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Color Schemes</span>
                  </div>
                  <div className="space-y-2">
                    {template.color_schemes.map((scheme) => (
                      <div 
                        key={scheme.name} 
                        className="flex items-center justify-between p-2 rounded-lg bg-white/40 dark:bg-gray-800/40"
                      >
                        <span className="text-sm font-medium">{scheme.name}</span>
                        <div className="flex gap-1">
                          <div 
                            className="w-4 h-4 rounded-full border border-gray-300 dark:border-gray-600" 
                            style={{ backgroundColor: scheme.colors.primary }}
                            title={`Primary: ${scheme.colors.primary}`}
                          />
                          <div 
                            className="w-4 h-4 rounded-full border border-gray-300 dark:border-gray-600" 
                            style={{ backgroundColor: scheme.colors.accent }}
                            title={`Accent: ${scheme.colors.accent}`}
                          />
                          <div 
                            className="w-4 h-4 rounded-full border border-gray-300 dark:border-gray-600" 
                            style={{ backgroundColor: scheme.colors.background }}
                            title={`Background: ${scheme.colors.background}`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mt-8 p-4 bg-muted/50 rounded-lg">
        <h3 className="font-semibold mb-2">Template Selection Guide:</h3>
        <div className="text-sm text-muted-foreground space-y-1">
          <div><strong className="text-blue-600 dark:text-blue-400">Minimal:</strong> Keynote-style presentations, tech demos, startup pitches</div>
          <div><strong className="text-emerald-600 dark:text-emerald-400">Corporate:</strong> Business reports, quarterly reviews, data-heavy content</div>
          <div><strong className="text-purple-600 dark:text-purple-400">Creative:</strong> Brand stories, portfolio showcases, artistic presentations</div>
        </div>
      </div>
    </div>
  );
} 