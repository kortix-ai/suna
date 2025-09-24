'use client';

import React, { useState } from 'react';
import { MarketplaceTemplate } from '@/components/agents/installation/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AgentIconAvatar } from '@/components/agents/config/agent-icon-avatar';
import { 
  Bot, 
  Download, 
  Share2, 
  ChevronRight, 
  Sparkles,
  Clock,
  Users,
  Zap,
  Shield,
  Code,
  Plug,
  Cpu,
  Globe,
  Terminal,
  GitBranch,
  CheckCircle,
  TrendingUp,
  Loader2,
  Star,
  Copy,
  ExternalLink,
  ArrowRight,
  Activity,
  Package,
  Layers,
  Workflow
} from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { backendApi } from '@/lib/api-client';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface AgentTemplateLandingPageProps {
  template: MarketplaceTemplate;
}

const IntegrationIcon: React.FC<{ 
  qualifiedName: string; 
  displayName: string; 
  customType?: string;
  size?: number;
}> = ({ qualifiedName, displayName, customType, size = 20 }) => {
  const firstLetter = displayName.charAt(0).toUpperCase();
  const getIconColor = () => {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', 
      '#FFEAA7', '#DDA0DD', '#98D8C8', '#FDA7DF'
    ];
    const index = displayName.charCodeAt(0) % colors.length;
    return colors[index];
  };

  const iconMap: Record<string, JSX.Element> = {
    'github': <GitBranch size={size} />,
    'browser': <Globe size={size} />,
    'terminal': <Terminal size={size} />,
    'code': <Code size={size} />,
  };

  const icon = iconMap[qualifiedName.toLowerCase()] || 
                iconMap[customType?.toLowerCase() || ''];

  if (icon) {
    return <div className="text-primary">{icon}</div>;
  }

  return (
    <div 
      className="flex items-center justify-center rounded"
      style={{ 
        backgroundColor: getIconColor() + '20',
        width: size + 8,
        height: size + 8
      }}
    >
      <span 
        className="font-semibold" 
        style={{ 
          color: getIconColor(),
          fontSize: size * 0.7
        }}
      >
        {firstLetter}
      </span>
    </div>
  );
};

export const AgentTemplateLandingPage: React.FC<AgentTemplateLandingPageProps> = ({ template }) => {
  const router = useRouter();
  const { user } = useAuth();
  const [isInstalling, setIsInstalling] = useState(false);

  const isSunaAgent = template.is_kortix_team || false;
  const tools = template.mcp_requirements || [];
  const integrations = tools.filter(tool => !tool.custom_type || tool.custom_type !== 'sse');
  const customTools = tools.filter(tool => tool.custom_type === 'sse');
  const agentpressTools = Object.entries(template.agentpress_tools || {})
    .filter(([_, enabled]) => enabled)
    .map(([toolName]) => toolName);

  const handleInstall = async () => {
    if (!user) {
      toast.error('Please sign in to install this agent');
      router.push('/auth');
      return;
    }

    setIsInstalling(true);
    try {
      const response = await backendApi.post(`/api/templates/${template.id}/install`);
      
      if (response?.data?.agent_id) {
        toast.success('Agent installed successfully!');
        router.push(`/?agent_id=${response.data.agent_id}`);
      } else {
        throw new Error('Invalid response: missing agent_id');
      }
    } catch (error: any) {
      console.error('Failed to install agent:', error);
      
      // Handle specific error cases
      if (error.response?.status === 403) {
        toast.error('Access denied. Please check your permissions.');
      } else if (error.response?.status === 404) {
        toast.error('Template not found');
      } else if (error.response?.data?.detail) {
        toast.error(error.response.data.detail);
      } else {
        toast.error('Failed to install agent. Please try again.');
      }
    } finally {
      setIsInstalling(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const fadeInUp = {
    initial: { opacity: 0, y: 20 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.5 }
  };

  const staggerChildren = {
    animate: {
      transition: {
        staggerChildren: 0.1
      }
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <section className="relative overflow-hidden">
        <div className="container mx-auto px-4 py-16 lg:py-24">
          <motion.div 
            className="max-w-4xl mx-auto text-center"
            initial="initial"
            animate="animate"
            variants={staggerChildren}
          >
            {isSunaAgent && (
              <motion.div 
                className="inline-flex items-center gap-2 mb-6"
                variants={fadeInUp}
              >
                <Badge variant="secondary" className="px-3 py-1 text-white">
                  Built by Kortix
                </Badge>
              </motion.div>
            )}

            <motion.div 
              className="flex justify-center mb-8"
              variants={fadeInUp}
            >
              <div className="relative">
                <AgentIconAvatar
                  profileImageUrl={template.profile_image_url}
                  iconName={template.icon_name}
                  iconColor={template.icon_color}
                  backgroundColor={template.icon_background}
                  agentName={template.name}
                  size={96}
                  className="shadow-lg"
                />
              </div>
            </motion.div>
            
            <motion.h1 
              className="text-3xl lg:text-4xl font-semibold mb-4 text-foreground"
              variants={fadeInUp}
            >
              {template.name}
            </motion.h1>
            
            <motion.p 
              className="text-base lg:text-lg text-muted-foreground mb-8 max-w-2xl mx-auto"
              variants={fadeInUp}
            >
              {template.description || 'A powerful AI agent ready to assist you'}
            </motion.p>
            <motion.div 
              className="flex flex-wrap justify-center gap-6 mb-10"
              variants={fadeInUp}
            >
              <div className="flex items-center gap-2 text-sm">
                <Download className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{template.download_count.toLocaleString()}</span>
                <span className="text-muted-foreground">installs</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">by</span>
                <span className="font-medium">{template.creator_name}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">{formatDate(template.created_at)}</span>
              </div>
            </motion.div>

            {/* <motion.div 
              className="flex flex-col sm:flex-row gap-3 justify-center"
              variants={fadeInUp}
            >
              <Button 
                size="lg" 
                onClick={handleInstall}
                disabled={isInstalling}
                className="px-6 py-3"
              >
                {isInstalling ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Installing...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    Install Agent
                  </>
                )}
              </Button>
              <Button 
                size="lg" 
                variant="outline"
                onClick={handleShare}
                className="px-6 py-3"
              >
                <Share2 className="mr-2 h-4 w-4" />
                Share Template
              </Button>
            </motion.div> */}
          </motion.div>
        </div>
      </section>
    </div>
  );
}; 