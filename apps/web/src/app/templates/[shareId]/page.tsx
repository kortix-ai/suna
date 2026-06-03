'use client';

import { useTranslations } from 'next-intl';

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useScroll } from 'framer-motion';
import { getEnv } from '@/lib/env-config';
import {
  Download,
  Share2,
  Sparkles,
  Calendar,
  User,
  Wrench,
  Plug,
  Code,
  Globe,
  Terminal,
  GitBranch,
  ArrowLeft,
  Moon,
  Sun,
  FileText,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UnifiedMarkdown } from '@/components/markdown';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import { AgentAvatar } from '@/components/thread/content/agent-avatar';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

interface MarketplaceTemplate {
  template_id: string;
  creator_id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  mcp_requirements: any[];
  agentpress_tools: Record<string, any>;
  tags: string[];
  is_public: boolean;
  is_kortix_team: boolean;
  marketplace_published_at: string | null;
  download_count: number;
  created_at: string;
  updated_at: string;
  icon_name: string | null;
  icon_color: string | null;
  icon_background: string | null;
  metadata: Record<string, any>;
  creator_name: string | null;
  usage_examples?: Array<{
    role: string;
    content: string;
    tool_calls?: Array<{
      name: string;
      arguments?: Record<string, any>;
    }>;
  }>;
}

const IntegrationIcon: React.FC<{
  qualifiedName: string;
  displayName: string;
  customType?: string;
  toolkitSlug?: string;
  size?: number;
}> = ({ qualifiedName, displayName, customType, size = 20 }) => {
  const firstLetter = displayName.charAt(0).toUpperCase();

  const iconMap: Record<string, React.JSX.Element> = {
    'github': <GitBranch size={size} />,
    'browser': <Globe size={size} />,
    'terminal': <Terminal size={size} />,
    'code': <Code size={size} />,
  };

  const fallbackIcon = iconMap[qualifiedName.toLowerCase()] ||
    iconMap[customType?.toLowerCase() || ''];

  if (fallbackIcon) {
    return <div className="text-muted-foreground">{fallbackIcon}</div>;
  }

  return (
    <div
      className="flex items-center justify-center rounded text-xs font-medium bg-muted"
      style={{ width: size, height: size }}
    >
      {firstLetter}
    </div>
  );
};



export default function TemplateSharePage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const params = useParams();
  const templateId = params.shareId as string; // Note: keeping shareId param name for URL compatibility
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [colorPalette, setColorPalette] = useState<string[]>([]);
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const [activeSection, setActiveSection] = useState('');
  const { scrollY } = useScroll();
  const [hasScrolled, setHasScrolled] = useState(false);

  // Helper functions and variables for navigation
  const scrollToSection = (sectionId: string) => {
    const element = document.getElementById(sectionId);
    if (element) {
      const yOffset = -100;
      const y = element.getBoundingClientRect().top + window.pageYOffset + yOffset;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
  };

  // Scroll detection for navbar
  useEffect(() => {
    const unsubscribe = scrollY.on('change', (latest) => {
      setHasScrolled(latest > 10);
    });
    return unsubscribe;
  }, [scrollY]);

  // Navigation state management
  useEffect(() => {
    const handleScroll = () => {
      const sections = ['system-prompt', 'integrations', 'tools'];
      let currentSection = '';

      // Find the section that's currently in view
      for (const section of sections) {
        const element = document.getElementById(section);
        if (element) {
          const rect = element.getBoundingClientRect();
          // Use a smaller offset for better responsiveness
          if (rect.top <= 200 && rect.bottom >= 100) {
            currentSection = section;
          }
        }
      }

      // If no section is in the main view area, find the closest one
      if (!currentSection) {
        let minDistance = Infinity;
        for (const section of sections) {
          const element = document.getElementById(section);
          if (element) {
            const rect = element.getBoundingClientRect();
            const distance = Math.abs(rect.top - 150);
            if (distance < minDistance) {
              minDistance = distance;
              currentSection = section;
            }
          }
        }
      }

      if (currentSection && currentSection !== activeSection) {
        setActiveSection(currentSection);
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, [activeSection]);

  const { data: template, isLoading, error } = useQuery({
    queryKey: ['template-public', templateId],
    queryFn: async () => {
      const backendUrl = getEnv().BACKEND_URL || 'http://localhost:8008/v1';
      const response = await fetch(`${backendUrl}/templates/public/${templateId}`);
      if (!response.ok) {
        throw new Error('Template not found');
      }
      return response.json() as Promise<MarketplaceTemplate>;
    },
    enabled: !!templateId,
  });

  useEffect(() => {
    if (template?.icon_name && template?.icon_background) {
      // For icons, use the icon background color as the primary color
      const iconBg = template.icon_background || '#e5e5e5';
      const iconColor = template.icon_color || '#000000';
      // Create a palette based on the icon colors
      setColorPalette([
        iconBg,
        iconColor,
        '#6366f1',
        '#8b5cf6',
        '#ec4899',
        '#f43f5e'
      ]);
    } else {
      setColorPalette([
        '#6366f1', '#8b5cf6', '#ec4899',
        '#f43f5e', '#f97316', '#facc15'
      ]);
    }
  }, [template?.icon_name, template?.icon_background, template?.icon_color]);

  const handleInstall = () => {
    if (!template) return;
    router.push(`/agents?tab=my-agents&agent=${template.template_id}`);
  };

  const handleShare = async () => {
    const currentUrl = window.location.href;
    try {
      await navigator.clipboard.writeText(currentUrl);
      toast.success('Share link copied to clipboard!');
    } catch {
      toast.error('Failed to copy link to clipboard');
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen">
        <div className="flex items-center justify-center h-screen">
          <KortixLoader size="large" />
        </div>
      </div>
    );
  }

  if (error || !template) {
    return (
      <div className="min-h-screen">
        <div className="flex items-center justify-center h-screen">
          <div className="text-center">
            <h2 className="text-2xl font-semibold mb-2">{tHardcodedUi.raw('appTemplatesShareidPage.line278JsxTextTemplateNotFound')}</h2>
            <p className="text-muted-foreground mb-4">{tHardcodedUi.raw('appTemplatesShareidPage.line279JsxTextTheTemplateYouReLookingForDoesnT')}</p>
            <Button onClick={() => router.push('/agents?tab=my-agents')}>{tHardcodedUi.raw('appTemplatesShareidPage.line281JsxTextBrowseAgents')}</Button>
          </div>
        </div>
      </div>
    );
  }

  const tools = Array.isArray(template.mcp_requirements) ? template.mcp_requirements : [];
  const toolRequirements = tools.filter((req: any) => req?.source === 'tool');
  const integrations = toolRequirements.filter((tool: any) => !tool?.custom_type || tool.custom_type !== 'sse');
  const customTools = toolRequirements.filter((tool: any) => tool?.custom_type === 'sse');

  // Navigation helper variables
  const hasIntegrations = integrations.length > 0;
  const [color1, color2, color3, color4] = colorPalette.length >= 6
    ? colorPalette
    : ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316', '#facc15'];

  const gradientStyle = {
    background: `radial-gradient(circle at 30% 20%, ${color2}90 0%, transparent 35%), radial-gradient(circle at 70% 80%, ${color3}80 0%, transparent 35%), radial-gradient(circle at 10% 60%, ${color1}85 0%, transparent 40%), radial-gradient(circle at 50% 50%, ${color4}70 0%, transparent 50%)`,
    filter: 'blur(80px) saturate(250%)',
    opacity: 1,
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Top Navigation Bar */}
      <header
        className={cn(
          'sticky z-50 flex justify-center transition-colors duration-300',
          hasScrolled ? 'top-6 mx-4 md:mx-0' : 'top-4 mx-2 md:mx-0',
        )}
      >
        <div className="w-full max-w-7xl">
          <div
            className={cn(
              'mx-auto rounded-2xl transition-colors duration-300',
              hasScrolled
                ? 'px-2 md:px-4 border border-border backdrop-blur-lg bg-background/75'
                : 'shadow-none px-3 md:px-6',
            )}
          >
            <div className="flex h-14 items-center">
              <div className="flex items-center">
                <Link href="/" className="flex items-center">
                  <KortixLogo size={24} />
                </Link>
              </div>
              <div className="flex items-center space-x-3 ml-auto">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                  className="h-8 w-8"
                >
                  <Sun className="h-4 w-4 rotate-0 scale-100 transition-colors dark:-rotate-90 dark:scale-0" />
                  <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-colors dark:rotate-0 dark:scale-100" />
                  <span className="sr-only">{tHardcodedUi.raw('appTemplatesShareidPage.line356JsxTextToggleTheme')}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleShare}
                  className="h-8 w-8"
                >
                  <Share2 className="h-4 w-4" />
                  <span className="sr-only">Share</span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleInstall}
                  className="font-normal tracking-wide"
                >
                  <Sparkles className="h-3 w-3 mr-2" />{tHardcodedUi.raw('appTemplatesShareidPage.line374JsxTextInstallAgent')}</Button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="w-full max-w-7xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-4">
            <div className="lg:sticky lg:top-24 space-y-6">
              <Link
                href="/agents?tab=my-agents"
                className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="w-4 h-4 mr-2" />{tHardcodedUi.raw('appTemplatesShareidPage.line392JsxTextBackToAgents')}</Link>
              <div className="relative">
                {colorPalette.length > 0 && (
                  <div
                    className="absolute -inset-10 rounded-2xl opacity-0 dark:opacity-100 transition-colors duration-1000 pointer-events-none"
                    style={gradientStyle}
                  />
                )}
                <div className="relative aspect-square w-full max-w-sm mx-auto lg:mx-0 rounded-2xl overflow-hidden bg-background">
                  <div className="w-full h-full flex items-center justify-center">
                    <AgentAvatar
                      iconName={template.icon_name}
                      iconColor={template.icon_color ?? undefined}
                      backgroundColor={template.icon_background ?? undefined}
                      agentName={template.name}
                      size={120}
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <h1 className="text-3xl font-medium tracking-tight">{template.name}</h1>
                  {template.is_kortix_team && (
                    <Badge variant="highlight" className="mt-2">
                      <Sparkles className="w-3 h-3 mr-1" />{tHardcodedUi.raw('appTemplatesShareidPage.line428JsxTextOfficialTemplate')}</Badge>
                  )}
                </div>

                <p className="text-muted-foreground">
                  {template.description || 'An AI agent template ready to be customized for your needs.'}
                </p>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <User className="w-4 h-4" />
                    <span>{tHardcodedUi.raw('appTemplatesShareidPage.line439JsxTextCreatedBy')}<span className="text-foreground font-medium">{template.creator_name || 'Anonymous'}</span></span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Download className="w-4 h-4" />
                    <span><span className="text-foreground font-medium">{template.download_count}</span> installs</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Calendar className="w-4 h-4" />
                    <span>{formatDate(template.created_at)}</span>
                  </div>
                </div>
                {template.tags.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {template.tags.map((tag, index) => (
                      <Badge key={index} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}

              </div>

              {/* Content Navigation */}
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground mb-3">Sections</h3>
                <nav className="space-y-1">
                  <button
                    onClick={() => scrollToSection('system-prompt')}
                    className="w-full px-3 py-2 text-sm rounded-lg transition-colors text-left flex items-center gap-2 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  >
                    <FileText className="w-4 h-4" />{tHardcodedUi.raw('appTemplatesShareidPage.line471JsxTextSystemPrompt')}</button>
                  {hasIntegrations && (
                    <button
                      onClick={() => scrollToSection('integrations')}
                      className="w-full px-3 py-2 text-sm rounded-lg transition-colors text-left flex items-center gap-2 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    >
                      <Plug className="w-4 h-4" />
                      Integrations
                    </button>
                  )}
                </nav>
              </div>
            </div>
          </div>

          <div className="lg:col-span-8 space-y-6">
            <Card id="system-prompt" className="bg-transparent border-0 shadow-none">
              <CardHeader className="px-0">
                <CardTitle className="text-xl flex items-center gap-2">
                  <FileText className="w-5 h-5" />{tHardcodedUi.raw('appTemplatesShareidPage.line492JsxTextSystemPrompt')}</CardTitle>
                <CardDescription>{tHardcodedUi.raw('appTemplatesShareidPage.line495JsxTextTheCoreInstructionsThatDefineThisAgentS')}</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <div className="rounded-2xl border bg-muted/10 p-6">
                  <div className="relative">
                    <div className={cn(
                      "transition-colors duration-300 overflow-hidden",
                      !isPromptExpanded && "max-h-[600px]"
                    )}>
                      <UnifiedMarkdown 
                        content={template.system_prompt || 'No system prompt available'} 
                        className="prose prose-sm dark:prose-invert max-w-none" 
                      />
                      {!isPromptExpanded && template.system_prompt && template.system_prompt.length > 10000 && (
                        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-muted/10 to-transparent pointer-events-none" />
                      )}
                    </div>
                    {template.system_prompt && template.system_prompt.length > 10000 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setIsPromptExpanded(!isPromptExpanded)}
                        className="mt-4 w-full justify-between text-muted-foreground hover:text-foreground"
                      >
                        <span>
                          {isPromptExpanded ? 'Show less' : `Show more (${template.system_prompt.length.toLocaleString()} characters)`}
                        </span>
                        {isPromptExpanded ? (
                          <ChevronUp className="h-4 w-4 ml-2" />
                        ) : (
                          <ChevronDown className="h-4 w-4 ml-2" />
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {integrations.length > 0 && (
              <Card id="integrations" className="bg-transparent border-0 shadow-none">
                <CardHeader className="px-0">
                  <CardTitle className="text-xl flex items-center gap-2">
                    <Plug className="w-5 h-5" />
                    Integrations
                  </CardTitle>
                  <CardDescription>{tHardcodedUi.raw('appTemplatesShareidPage.line543JsxTextExternalServicesAndApisThisAgentCanConnect')}</CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {integrations.map((integration: any, index: number) => (
                      <div
                        key={index}
                        className="flex items-center gap-3 p-3 rounded-2xl border bg-background"
                      >
                        <IntegrationIcon
                          qualifiedName={integration.qualified_name}
                          displayName={integration.display_name || integration.qualified_name}
                          customType={integration.custom_type}
                          toolkitSlug={integration.toolkit_slug}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">
                            {integration.display_name || integration.qualified_name}
                          </p>
                          {integration.enabled_tools?.length > 0 && (
                            <p className="text-xs text-muted-foreground">
                              {integration.enabled_tools.length} tools
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
            {customTools.length > 0 && (
              <Card id="tools" className="bg-transparent border-0 shadow-none">
                <CardHeader className="px-0">
                  <CardTitle className="text-xl flex items-center gap-2">
                    <Wrench className="w-5 h-5" />{tHardcodedUi.raw('appTemplatesShareidPage.line580JsxTextCustomTools')}</CardTitle>
                  <CardDescription>{tHardcodedUi.raw('appTemplatesShareidPage.line583JsxTextSpecializedToolsBuiltForThisAgent')}</CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {customTools.map((tool: any, index: number) => (
                      <div
                        key={index}
                        className="flex items-center gap-3 p-3 rounded-2xl border bg-background"
                      >
                        <IntegrationIcon
                          qualifiedName={tool.qualified_name}
                          displayName={tool.display_name || tool.qualified_name}
                          customType={tool.custom_type}
                          toolkitSlug={tool.toolkit_slug}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">
                            {tool.display_name || tool.qualified_name}
                          </p>
                          {tool.enabled_tools?.length > 0 && (
                            <p className="text-xs text-muted-foreground">
                              {tool.enabled_tools.length} capabilities
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
            {/* 
            <Card className="bg-muted/30 border-muted/50">
              <CardContent className="p-8 text-center">
                <h3 className="text-2xl font-medium mb-4">Ready to get started?</h3>
                <p className="text-muted-foreground mb-6">
                  Install this agent template and customize it for your specific needs
                </p>
                <div className="flex flex-col sm:flex-row gap-3 justify-center">
                  <Button 
                    size="lg"
                    onClick={handleInstall}
                  >
                    <Download className="h-4 w-4" />
                    Install Now
                  </Button>
                  <Button 
                    size="lg"
                    variant="outline"
                    onClick={() => router.push('/agents?tab=my-agents')}
                  >
                    Browse More Agents
                  </Button>
                </div>
              </CardContent>
            </Card>
            */}
          </div>
        </div>
      </div>
    </div>
  );
} 
