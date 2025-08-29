import React, { useRef, useCallback, useMemo, useState, useEffect } from 'react';
import { Settings, Trash2, Star, MessageCircle, Wrench, Globe, Download, Bot, User, Calendar, Tags, Sparkles, Zap, BookOpen, Share2, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { useCurrentAccount } from '@/hooks/use-current-account';
import { useAccounts } from '@/hooks/use-accounts';
import { getAgentAvatar } from '@/app/(dashboard)/agents/_utils/get-agent-style';
import './AgentProfileCard.css';

// Simple Agent interface matching existing codebase
interface Agent {
  agent_id: string;
  name: string;
  description?: string;
  configured_mcps?: Array<{ name: string; [key: string]: any }>;
  custom_mcps?: Array<{ name: string; [key: string]: any }>;
  agentpress_tools?: Record<string, any>;
  is_default?: boolean;
  is_public?: boolean;
  is_managed?: boolean;
  is_owned?: boolean;
  visibility?: 'public' | 'teams' | 'private';
  download_count?: number;
  tags?: string[];
  avatar?: string;
  avatar_color?: string;
  created_at?: string;
  marketplace_published_at?: string;
  creator_name?: string;
  knowledge_bases?: Array<{ name: string; [key: string]: any }>;
  sharing_preferences?: {
    managed_agent?: boolean;
    include_knowledge_bases?: boolean;
    include_custom_mcp_tools?: boolean;
    [key: string]: any;
  };
}

interface AgentProfileCardProps {
  agent: Agent;
  mode?: 'library' | 'marketplace';
  className?: string;
  onChat?: (agentId: string) => void;
  onCustomize?: (agentId: string) => void;
  onDelete?: (agentId: string) => void;
  onRemoveFromLibrary?: (agentId: string) => void;
  onAddToLibrary?: (agentId: string) => void;
  onPublish?: (agentId: string) => void;
  onMakePrivate?: (agentId: string) => void;
  onShare?: (agentId: string) => void;
  isLoading?: boolean;
  enableTilt?: boolean;
  isHighlighted?: boolean;
  onHighlightChange?: (agentId: string | null) => void;
  isAddedToLibrary?: boolean;
}



const getToolsCount = (agent: Agent) => {
  const mcpCount = agent.configured_mcps?.length || 0;
  const customMcpCount = agent.custom_mcps?.length || 0;
  const agentpressCount = Object.values(agent.agentpress_tools || {}).filter(
    tool => tool && typeof tool === 'object' && tool.enabled
  ).length;
  return mcpCount + customMcpCount + agentpressCount;
};

const getKnowledgeBasesCount = (agent: Agent) => {
  return agent.knowledge_bases?.length || 0;
};

const truncateDescription = (description?: string, maxLength = 120) => {
  if (!description) return "🤖 *Mysterious agent with no description* - What am I? That's for me to know and you to find out!";
  if (description.length <= maxLength) return description;
  
  // Find the last space before the maxLength to avoid cutting words
  const truncated = description.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  
  if (lastSpace > 0 && lastSpace > maxLength - 20) {
    return truncated.substring(0, lastSpace).trim() + '...';
  }
  
  return truncated.trim() + '...';
};

const formatDate = (dateString?: string) => {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric', 
    year: 'numeric' 
  });
};

interface DescriptionSectionProps {
  description?: string;
  isHighlighted: boolean;
}

const DescriptionSection: React.FC<DescriptionSectionProps> = ({ description, isHighlighted }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const defaultDescription = "🤖 *Mysterious agent with no description* - What am I? That's for me to know and you to find out!";
  const displayDescription = description || defaultDescription;
  const shouldShowReadMore = description && description.length > 120;
  
  const truncatedDescription = shouldShowReadMore 
    ? (() => {
        const truncated = description.substring(0, 120);
        const lastSpace = truncated.lastIndexOf(' ');
        return lastSpace > 0 && lastSpace > 100 
          ? truncated.substring(0, lastSpace).trim() + '...'
          : truncated.trim() + '...';
      })()
    : displayDescription;

  return (
    <div className="flex-1 mb-4">
      <div className={cn(
        "text-muted-foreground text-sm leading-relaxed transition-colors duration-300 group-hover:text-foreground/85 break-words",
        isHighlighted && "text-foreground/85"
      )}>
        {!isExpanded ? (
          <p>{truncatedDescription}</p>
        ) : (
          <div className="max-h-32 overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
            <p>{displayDescription}</p>
          </div>
        )}
        
        {shouldShowReadMore && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            className={cn(
              "text-xs font-medium mt-2 transition-colors duration-200 hover:text-foreground/90 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-background rounded-sm px-1",
              isHighlighted 
                ? "text-foreground/70 hover:text-foreground" 
                : "text-muted-foreground/80 hover:text-foreground/70"
            )}
          >
            {isExpanded ? 'Read less' : 'Read more'}
          </button>
        )}
      </div>
    </div>
  );
};

export const AgentProfileCard: React.FC<AgentProfileCardProps> = ({
  agent,
  mode = 'library',
  className = '',
  onChat,
  onCustomize,
  onDelete,
  onRemoveFromLibrary,
  onAddToLibrary,
  onPublish,
  onMakePrivate,
  onShare,
  isLoading = false,
  enableTilt = true,
  isHighlighted = false,
  onHighlightChange,
  isAddedToLibrary = false,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  
  // Team context and permissions
  const currentAccount = useCurrentAccount();
  const { data: accounts } = useAccounts();
  
  // Determine user permissions based on team context
  const permissions = useMemo(() => {
    // If not in team context, user has full permissions (personal account)
    if (!currentAccount?.is_team_context) {
      return {
        canEdit: !agent.is_managed && agent.is_owned,
        canPublish: !agent.is_managed && agent.is_owned,
        canShare: !agent.is_managed && agent.is_owned,
        canDelete: !agent.is_managed && agent.is_owned && !agent.is_default,
      };
    }
    
    // In team context - check if user is admin/owner of the team
    const currentTeamAccount = accounts?.find(acc => 
      acc.account_id === currentAccount.account_id && !acc.personal_account
    );
    const isTeamAdmin = (currentTeamAccount as any)?.account_role === 'owner';
    
    return {
      canEdit: isTeamAdmin && !agent.is_managed && agent.is_owned,
      canPublish: false, // No publishing to marketplace in team context
      canShare: false,   // No sharing in team context
      canDelete: isTeamAdmin && !agent.is_managed && agent.is_owned && !agent.is_default,
    };
  }, [currentAccount, accounts, agent]);

  // Get agent styling
  const agentStyling = useMemo(() => {
    if (agent.avatar && agent.avatar_color) {
      return { avatar: agent.avatar, color: agent.avatar_color };
    }
    return getAgentAvatar(agent.agent_id);
  }, [agent.agent_id, agent.avatar, agent.avatar_color]);

  // Mobile tap handlers with scroll detection
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (isMobile && e.touches.length === 1) {
      const touch = e.touches[0];
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now()
      };
    }
  }, [isMobile]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (isMobile && touchStartRef.current && onHighlightChange) {
      const touch = e.changedTouches[0];
      const touchStart = touchStartRef.current;
      
      // Calculate movement and time
      const deltaX = Math.abs(touch.clientX - touchStart.x);
      const deltaY = Math.abs(touch.clientY - touchStart.y);
      const deltaTime = Date.now() - touchStart.time;
      
      // Only highlight if:
      // 1. Movement is small (< 10px in any direction) - not scrolling
      // 2. Touch duration is reasonable (< 500ms) - not a long press
      const isValidTap = deltaX < 10 && deltaY < 10 && deltaTime < 500;
      
      if (isValidTap) {
        // Check if the touch target is a button or inside a button/dropdown
        const target = e.target as HTMLElement;
        const isClickableElement = target.closest('button, [role="menuitem"], [role="button"], a, input, select, textarea') !== null;
        
        if (!isClickableElement) {
          // Only prevent default and toggle highlight if not touching a clickable element
          e.preventDefault();
          // Toggle highlight state
          onHighlightChange(isHighlighted ? null : agent.agent_id);
        }
      }
      
      touchStartRef.current = null;
    }
  }, [isMobile, onHighlightChange, isHighlighted, agent.agent_id]);

  const handleTouchCancel = useCallback(() => {
    if (isMobile) {
      touchStartRef.current = null;
    }
  }, [isMobile]);

  // Enhanced tilt effect with subtle rotation
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!enableTilt || !cardRef.current) return;
    
    const card = cardRef.current;
    const rect = card.getBoundingClientRect();
    
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    const rotateX = (y - centerY) / 25; // Slightly more pronounced
    const rotateY = (centerX - x) / 25; // Slightly more pronounced
    
    // Calculate position percentages for gradient effects
    const xPercent = (x / rect.width) * 100;
    const yPercent = (y / rect.height) * 100;
    
    card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateZ(5px)`;
    card.style.setProperty('--mouse-x', `${xPercent}%`);
    card.style.setProperty('--mouse-y', `${yPercent}%`);
  }, [enableTilt]);

  const handleMouseLeave = useCallback(() => {
    if (!cardRef.current) return;
    cardRef.current.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) translateZ(0)';
  }, []);

  const toolsCount = getToolsCount(agent);

  return (
    <div
      ref={cardRef}
      data-agent-id={agent.agent_id}
      className={cn(
        'group relative w-full min-h-[400px] rounded-2xl overflow-hidden transition-all duration-500 ease-out cursor-pointer',
        'hover:shadow-2xl hover:shadow-black/30 hover:-translate-y-2',
        // Enhanced hover glow effect
        'before:absolute before:inset-0 before:rounded-2xl before:p-[1px] before:bg-gradient-to-br before:opacity-0',
        'hover:before:opacity-100 before:transition-opacity before:duration-500',
        // Mobile tap effects (same as hover)
        isHighlighted && [
          'shadow-2xl shadow-black/30 -translate-y-2',
          'before:opacity-100'
        ],
        className
      )}
      onClick={(e) => {
        // Handle card click in marketplace mode - navigate to chat with the agent
        if (mode === 'marketplace') {
          const target = e.target as HTMLElement;
          const isClickingButton = target.closest('button') !== null;
          
          if (!isClickingButton) {
            onChat?.(agent.agent_id);
          }
        }
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      style={{
        background: `
          linear-gradient(135deg, 
            ${agentStyling.color}08 0%, 
            ${agentStyling.color}03 100%
          ),
          linear-gradient(145deg, 
            rgba(255, 255, 255, 0.1) 0%, 
            rgba(255, 255, 255, 0.05) 100%
          )
        `,
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12)',
        // CSS variables for mouse position
        '--mouse-x': '50%',
        '--mouse-y': '50%',
      } as React.CSSProperties}
    >
      {/* Animated border glow on hover */}
      <div 
        className={cn(
          "absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 card-border-glow",
          isHighlighted && "opacity-100"
        )}
        style={{
          background: `
            linear-gradient(135deg, 
              ${agentStyling.color}40 0%, 
              ${agentStyling.color}20 50%,
              ${agentStyling.color}40 100%
            )
          `,
          filter: 'blur(8px)',
          zIndex: -1,
        }}
      />
      
      {/* Spotlight effect following mouse */}
      <div 
        className={cn(
          "absolute inset-0 opacity-0 group-hover:opacity-30 transition-opacity duration-300 pointer-events-none",
          isHighlighted && "opacity-30"
        )}
        style={{
          background: `
            radial-gradient(
              200px circle at var(--mouse-x) var(--mouse-y),
              ${agentStyling.color}20 0%,
              transparent 50%
            )
          `,
        }}
      />
      
      {/* Enhanced Colored Glare Effect */}
      <div 
        className={cn(
          "absolute inset-0 opacity-0 group-hover:opacity-70 transition-opacity duration-500 pointer-events-none overflow-hidden glare-sweep-colored-animation",
          isHighlighted && "opacity-70"
        )}
        style={{
          background: `
            linear-gradient(
              75deg,
              transparent 20%,
              ${agentStyling.color}40 35%,
              ${agentStyling.color}80 45%,
              ${agentStyling.color}60 55%,
              ${agentStyling.color}40 65%,
              transparent 80%
            )
          `,
        }}
      />
      
      {/* Subtle gradient overlay with enhanced hover effect */}
      <div 
        className={cn(
          "absolute inset-0 opacity-0 group-hover:opacity-100 transition-all duration-500",
          isHighlighted && "opacity-100"
        )}
        style={{
          background: `
            linear-gradient(135deg, 
              ${agentStyling.color}12 0%, 
              ${agentStyling.color}06 100%
            )
          `,
        }}
      />
      
      {/* Content */}
      <div className="relative h-full flex flex-col p-6 z-10">
        {/* Main Content Area */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div 
              className={cn(
                "w-12 h-12 rounded-xl flex items-center justify-center text-2xl shadow-lg transition-all duration-300 group-hover:shadow-xl group-hover:scale-105 agent-avatar",
                isHighlighted && "shadow-xl scale-105"
              )}
              style={{
                background: `linear-gradient(135deg, ${agentStyling.color}25 0%, ${agentStyling.color}45 100%)`,
                border: `1px solid ${agentStyling.color}40`,
                boxShadow: `0 4px 15px ${agentStyling.color}20`,
                '--agent-color': agentStyling.color,
              } as React.CSSProperties}
            >
              {agentStyling.avatar}
            </div>
            <div>
              <h3 className={cn(
                "text-xl font-semibold text-foreground/90 break-words max-w-[160px] sm:max-w-[200px] transition-colors duration-300 group-hover:text-foreground",
                isHighlighted && "text-foreground"
              )}>
                {agent.name}
              </h3>
              <div className="flex items-center gap-2 mt-1">
                {agent.is_default && (
                  <Badge variant="secondary" className="text-xs bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30 transition-all duration-300 group-hover:bg-amber-500/30">
                    <Star className="h-3 w-3 mr-1" />
                    Default
                  </Badge>
                )}
                {/* Visibility badges - mutually exclusive */}
                {(agent.is_public || agent.visibility === 'public') && (
                  <Badge variant="secondary" className="text-xs bg-green-500/20 text-green-600 dark:text-green-400 border-green-500/30 transition-all duration-300 group-hover:bg-green-500/30">
                    <Globe className="h-3 w-3 mr-1" />
                    Public
                  </Badge>
                )}
                {agent.visibility === 'teams' && !agent.is_public && (
                  <Badge variant="secondary" className="text-xs bg-purple-500/20 text-purple-600 dark:text-purple-400 border-purple-500/30 transition-all duration-300 group-hover:bg-purple-500/30">
                    <Bot className="h-3 w-3 mr-1" />
                    Teams
                  </Badge>
                )}
                {(agent.is_managed || (mode === 'marketplace' && agent.sharing_preferences?.managed_agent)) && (
                  <Badge variant="secondary" className="text-xs bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30 transition-all duration-300 group-hover:bg-blue-500/30">
                    <Sparkles className="h-3 w-3 mr-1" />
                    Managed
                  </Badge>
                )}
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {/* Download count for marketplace */}
            {mode === 'marketplace' && (
              <div className="flex items-center gap-1 text-muted-foreground text-sm transition-colors duration-300 group-hover:text-foreground/80">
                <Download className="h-4 w-4" />
                <span>{agent.download_count || 0}</span>
              </div>
            )}
            
            {/* Delete/Remove from Library button for library mode */}
            {mode === 'library' && permissions.canDelete && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button 
                    variant="ghost" 
                    size="sm"
                    className={cn(
                      "h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-all duration-200 hover:bg-red-500/20 hover:text-red-400 dark:hover:text-red-300 text-muted-foreground",
                      isHighlighted && "opacity-100"
                    )}
                    disabled={isLoading}
                    title={agent.is_managed ? "Remove from library" : "Delete agent"}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="max-w-md">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-xl">
                      {agent.is_managed ? 'Remove from Library' : 'Delete Agent'}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {agent.is_managed ? (
                        <>
                          Are you sure you want to remove &quot;{agent.name}&quot; from your library? 
                          This will not delete the original agent, just remove your access to it.
                        </>
                      ) : (
                        <>
                          Are you sure you want to delete &quot;{agent.name}&quot;? This action cannot be undone.
                          {agent.is_public && (
                            <span className="block mt-2 text-amber-600 dark:text-amber-400">
                              Note: This agent is currently published to the marketplace and will be removed from there as well.
                            </span>
                          )}
                        </>
                      )}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel onClick={(e) => e.stopPropagation()}>
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(e) => {
                        e.stopPropagation();
                        if (agent.is_managed) {
                          onRemoveFromLibrary?.(agent.agent_id);
                        } else {
                          onDelete?.(agent.agent_id);
                        }
                      }}
                      disabled={isLoading}
                      className="bg-destructive hover:bg-destructive/90 text-white"
                    >
                      {isLoading ? 
                        (agent.is_managed ? 'Removing...' : 'Deleting...') : 
                        (agent.is_managed ? 'Remove' : 'Delete')
                      }
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>

        {/* Description */}
        <DescriptionSection 
          description={agent.description} 
          isHighlighted={isHighlighted}
        />

                  {/* Tools and Info */}
        <div className="space-y-3 mb-4">
          {/* Tools - show count based on what's actually available in marketplace vs library */}
          {(() => {
            if (mode === 'marketplace') {
              // In marketplace, only show tools that will actually be shared
              const mcpCount = (agent.configured_mcps?.length || 0) + (agent.custom_mcps?.length || 0);
              const mcpToolsIncluded = agent.sharing_preferences?.include_custom_mcp_tools !== false;
              const agentpressCount = Object.values(agent.agentpress_tools || {}).filter(
                tool => tool && typeof tool === 'object' && tool.enabled
              ).length;
              
              const displayCount = (mcpToolsIncluded ? mcpCount : 0) + agentpressCount;
              
              if (displayCount > 0) {
                return (
                  <div className="flex items-center gap-2 transition-colors duration-300 group-hover:text-foreground/90">
                    <Zap className="h-4 w-4 text-muted-foreground group-hover:text-foreground/80 transition-colors duration-300" />
                    <span className="text-muted-foreground text-sm group-hover:text-foreground/90 transition-colors duration-300">
                      {displayCount} tool{displayCount !== 1 ? 's' : ''} available
                    </span>
                  </div>
                );
              }
            } else {
              // In library mode, show all tools
              if (toolsCount > 0) {
                return (
                  <div className="flex items-center gap-2 transition-colors duration-300 group-hover:text-foreground/90">
                    <Zap className="h-4 w-4 text-muted-foreground group-hover:text-foreground/80 transition-colors duration-300" />
                    <span className="text-muted-foreground text-sm group-hover:text-foreground/90 transition-colors duration-300">
                      {toolsCount} tool{toolsCount !== 1 ? 's' : ''} available
                    </span>
                  </div>
                );
              }
            }
            return null;
          })()}

          {/* Knowledge Bases - only show if shared in marketplace mode */}
          {(() => {
            const knowledgeBasesCount = getKnowledgeBasesCount(agent);
            const shouldShow = knowledgeBasesCount > 0 && (
              mode === 'library' || 
              (mode === 'marketplace' && agent.sharing_preferences?.include_knowledge_bases !== false)
            );
            
            if (shouldShow) {
              return (
                <div className="flex items-center gap-2 transition-colors duration-300 group-hover:text-foreground/90">
                  <BookOpen className="h-4 w-4 text-muted-foreground group-hover:text-foreground/80 transition-colors duration-300" />
                  <span className="text-muted-foreground text-sm group-hover:text-foreground/90 transition-colors duration-300">
                    {knowledgeBasesCount} knowledge base{knowledgeBasesCount !== 1 ? 's' : ''} connected
                  </span>
                </div>
              );
            }
            return null;
          })()}

          {/* Creator info for marketplace */}
          {mode === 'marketplace' && agent.creator_name && (
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground group-hover:text-foreground/80 transition-colors duration-300" />
              <span className="text-muted-foreground text-sm group-hover:text-foreground/80 transition-colors duration-300">
                By {agent.creator_name}
              </span>
            </div>
          )}

          {/* Date */}
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground group-hover:text-foreground/80 transition-colors duration-300" />
            <span className="text-muted-foreground text-sm group-hover:text-foreground/80 transition-colors duration-300">
              {mode === 'marketplace' ? 
                `Published ${formatDate(agent.marketplace_published_at)}` : 
                `Created ${formatDate(agent.created_at)}`
              }
            </span>
          </div>

          {/* Tags */}
          {agent.tags && agent.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 overflow-hidden">
              {agent.tags.slice(0, 3).map((tag, index) => (
                <Badge 
                  key={index} 
                  variant="secondary" 
                  className="text-xs bg-muted/50 text-muted-foreground border-border/50 transition-all duration-300 group-hover:bg-muted/70 group-hover:text-foreground/85 truncate max-w-[120px] flex-shrink-0"
                  title={tag}
                >
                  {tag}
                </Badge>
              ))}
              {agent.tags.length > 3 && (
                <Badge 
                  variant="secondary" 
                  className="text-xs bg-muted/50 text-muted-foreground border-border/50 transition-all duration-300 group-hover:bg-muted/70 group-hover:text-foreground/85 flex-shrink-0"
                >
                  +{agent.tags.length - 3}
                </Badge>
              )}
            </div>
          )}
        </div>
        </div>

        {/* Actions */}
        <div className={cn(
          "flex pt-6 mt-auto",
          mode === 'marketplace' ? "justify-center" : "gap-2 flex-wrap"
        )}>
          {mode === 'marketplace' ? (
            isAddedToLibrary ? (
              <Button
                disabled
                size="sm"
                className="min-w-[160px] bg-green-500/20 hover:bg-green-500/25 text-green-700 dark:text-green-400 border-green-500/30 backdrop-blur-sm transition-all duration-300"
                style={{
                  boxShadow: `0 4px 15px ${agentStyling.color}10`,
                }}
              >
                <CheckCircle className="h-4 w-4 mr-2 flex-shrink-0" />
                <span className="truncate">Added to Library</span>
              </Button>
            ) : (
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onAddToLibrary?.(agent.agent_id);
                }}
                disabled={isLoading}
                size="sm"
                className="min-w-[160px] bg-background/10 hover:bg-background/25 text-foreground border-border/20 backdrop-blur-sm transition-all duration-300 hover:shadow-lg"
                style={{
                  boxShadow: `0 4px 15px ${agentStyling.color}10`,
                }}
              >
                {isLoading ? (
                  <>
                    <div className="h-3 w-3 animate-spin rounded-full border-2 border-foreground border-t-transparent mr-2 flex-shrink-0" />
                    <span className="truncate">Adding...</span>
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4 mr-2 flex-shrink-0" />
                    <span className="truncate">Add to Library</span>
                  </>
                )}
              </Button>
            )
          ) : (
            <>
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onChat?.(agent.agent_id);
                }}
                size="sm"
                className="flex-1 min-w-0 bg-background/10 hover:bg-background/25 text-foreground border-border/20 backdrop-blur-sm transition-all duration-300 hover:shadow-lg"
                style={{
                  boxShadow: `0 4px 15px ${agentStyling.color}10`,
                }}
              >
                <MessageCircle className="h-4 w-4 mr-2 flex-shrink-0" />
                <span className="truncate">Chat</span>
              </Button>
              
              {permissions.canEdit && (
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCustomize?.(agent.agent_id);
                  }}
                  size="sm"
                  variant="outline"
                  className="flex-shrink-0 w-10 h-8 p-0 bg-background/5 hover:bg-background/15 text-muted-foreground border-border/20 backdrop-blur-sm transition-all duration-300 hover:shadow-lg hover:text-foreground"
                  title="Customize agent"
                >
                  <Wrench className="h-4 w-4" />
                </Button>
              )}
              
              {/* Publish/Make Private Button with confirmation for managed agents */}
              {permissions.canPublish && (
                agent.is_public || agent.marketplace_published_at ? (
                  agent.sharing_preferences?.managed_agent ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          onClick={(e) => e.stopPropagation()}
                          size="sm"
                          variant="outline"
                          className="flex-shrink-0 whitespace-nowrap bg-background/5 hover:bg-background/15 text-muted-foreground border-border/20 backdrop-blur-sm transition-all duration-300 hover:shadow-lg hover:text-foreground"
                        >
                          <Globe className="h-4 w-4 mr-1 flex-shrink-0" />
                          <span className="hidden sm:inline">Private</span>
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Make Agent Private</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will make your agent private and remove it from the marketplace. 
                            Your agent will still be marked as "Managed" since it was previously published as a managed agent.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel onClick={(e) => e.stopPropagation()}>
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            onClick={(e) => {
                              e.stopPropagation();
                              onMakePrivate?.(agent.agent_id);
                            }}
                            disabled={isLoading}
                            className="bg-destructive hover:bg-destructive/90 text-white"
                          >
                            {isLoading ? 'Making Private...' : 'Make Private'}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : (
                    <Button
                      onClick={(e) => {
                        e.stopPropagation();
                        onMakePrivate?.(agent.agent_id);
                      }}
                      size="sm"
                      variant="outline"
                      className="flex-shrink-0 whitespace-nowrap bg-background/5 hover:bg-background/15 text-muted-foreground border-border/20 backdrop-blur-sm transition-all duration-300 hover:shadow-lg hover:text-foreground"
                    >
                      <Globe className="h-4 w-4 mr-1 flex-shrink-0" />
                      <span className="hidden sm:inline">Private</span>
                    </Button>
                  )
                ) : (
                  <Button
                    onClick={(e) => {
                      e.stopPropagation();
                      onPublish?.(agent.agent_id);
                    }}
                    size="sm"
                    variant="outline"
                    className="flex-shrink-0 whitespace-nowrap bg-background/5 hover:bg-background/15 text-muted-foreground border-border/20 backdrop-blur-sm transition-all duration-300 hover:shadow-lg hover:text-foreground"
                  >
                    <Globe className="h-4 w-4 mr-1 flex-shrink-0" />
                    <span className="hidden sm:inline">Publish</span>
                  </Button>
                )
              )}
              
              {/* Share Button */}
              {permissions.canShare && (
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    onShare?.(agent.agent_id);
                  }}
                  size="sm"
                  variant="outline"
                  className="flex-shrink-0 w-10 h-8 p-0 bg-background/5 hover:bg-background/15 text-muted-foreground border-border/20 backdrop-blur-sm transition-all duration-300 hover:shadow-lg hover:text-foreground"
                  title="Share agent"
                >
                  <Share2 className="h-4 w-4" />
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentProfileCard;