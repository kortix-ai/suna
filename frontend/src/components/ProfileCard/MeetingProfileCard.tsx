import React, { useRef, useCallback, useMemo, useState } from 'react';
import { FileAudio, MoreHorizontal, Edit2, Trash2, Download, Share2, Move, MessageSquare, Calendar, Clock, Users, FolderOpen, Folder } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { formatDistanceToNow, format } from 'date-fns';
import './AgentProfileCard.css';

interface Meeting {
  meeting_id: string;
  title: string;
  status: 'active' | 'completed' | 'failed';
  created_at: string;
  updated_at?: string;
  folder_id?: string;
  transcript?: string;
  duration?: number;
  participant_count?: number;
}

interface MeetingFolder {
  folder_id: string;
  name: string;
  parent_folder_id?: string;
}

interface MeetingProfileCardProps {
  meeting: Meeting;
  type: 'meeting';
  className?: string;
  onEdit?: (meetingId: string, currentTitle: string) => void;
  onDelete?: (meetingId: string) => void;
  onDownloadTranscript?: (meeting: Meeting) => void;
  onOpenInChat?: (meetingId: string) => void;
  onMove?: (meetingId: string, targetFolderId?: string) => void;
  folders?: MeetingFolder[];
  enableTilt?: boolean;
  isDragging?: boolean;
  onDragStart?: (e: React.DragEvent, type: 'meeting', id: string) => void;
  isHighlighted?: boolean;
  onHighlightChange?: (id: string | null, type: 'meeting' | 'folder') => void;
}

interface FolderProfileCardProps {
  folder: MeetingFolder;
  type: 'folder';
  className?: string;
  onEdit?: (folderId: string, currentName: string) => void;
  onDelete?: (folderId: string) => void;
  onNavigate?: (folder: MeetingFolder) => void;
  onMove?: (folderId: string, targetFolderId?: string) => void;
  folders?: MeetingFolder[];
  meetingCount?: number;
  enableTilt?: boolean;
  isDragging?: boolean;
  onDragStart?: (e: React.DragEvent, type: 'folder', id: string) => void;
  onDragOver?: (e: React.DragEvent, folderId: string) => void;
  onDragLeave?: (e: React.DragEvent, folderId: string) => void;
  onDrop?: (e: React.DragEvent, folderId: string) => void;
  dragOverTarget?: string | null;
  isHighlighted?: boolean;
  onHighlightChange?: (id: string | null, type: 'meeting' | 'folder') => void;
}

type MeetingCardProps = MeetingProfileCardProps | FolderProfileCardProps;

const getStatusColor = (status: string) => {
  switch (status) {
    case 'active':
      return {
        background: 'linear-gradient(135deg, #10B981 0%, #059669 100%)',
        color: '#10B981',
        textColor: 'text-white',
        bgColor: 'bg-emerald-600',
        borderColor: 'border-emerald-600/50'
      };
    case 'completed':
      return {
        background: 'linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)',
        color: '#6366F1',
        textColor: 'text-white',
        bgColor: 'bg-indigo-600',
        borderColor: 'border-indigo-600/50'
      };
    case 'failed':
      return {
        background: 'linear-gradient(135deg, #EF4444 0%, #DC2626 100%)',
        color: '#EF4444',
        textColor: 'text-white',
        bgColor: 'bg-red-600',
        borderColor: 'border-red-600/50'
      };
    default:
      return {
        background: 'linear-gradient(135deg, #64748B 0%, #475569 100%)',
        color: '#64748B',
        textColor: 'text-white',
        bgColor: 'bg-slate-600',
        borderColor: 'border-slate-600/50'
      };
  }
};

const getFolderColor = () => {
  return {
    background: 'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)',
    color: '#F59E0B',
    textColor: 'text-white',
    bgColor: 'bg-amber-600',
    borderColor: 'border-amber-600/50'
  };
};

const formatDuration = (duration?: number) => {
  if (!duration) return null;
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
};

const MeetingCard: React.FC<MeetingProfileCardProps> = ({
  meeting,
  className = '',
  onEdit,
  onDelete,
  onDownloadTranscript,
  onOpenInChat,
  onMove,
  folders = [],
  enableTilt = true,
  isDragging = false,
  onDragStart,
  isHighlighted = false,
  onHighlightChange,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const statusColors = getStatusColor(meeting.status);

  // Enhanced tilt effect
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!enableTilt || !cardRef.current) return;
    
    const card = cardRef.current;
    const rect = card.getBoundingClientRect();
    
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    const rotateX = (y - centerY) / 25;
    const rotateY = (centerX - x) / 25;
    
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
          onHighlightChange(isHighlighted ? null : meeting.meeting_id, 'meeting');
        }
      }
      
      touchStartRef.current = null;
    }
  }, [isMobile, onHighlightChange, isHighlighted, meeting.meeting_id]);

  const handleTouchCancel = useCallback(() => {
    if (isMobile) {
      touchStartRef.current = null;
    }
  }, [isMobile]);

  const buildFolderTree = (folders: MeetingFolder[], parentId?: string): MeetingFolder[] => {
    return folders
      .filter(folder => folder.parent_folder_id === parentId)
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const renderFolderMenuItem = (folder: MeetingFolder, depth = 0): React.ReactNode => {
    const children = buildFolderTree(folders, folder.folder_id);
    const hasChildren = children.length > 0;
    
    if (hasChildren) {
      return (
        <DropdownMenuSub key={folder.folder_id}>
          <DropdownMenuSubTrigger className={cn("pl-2", depth > 0 && "pl-4")}>
            <Folder className="h-4 w-4 mr-2" />
            {folder.name}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={(e) => onMove?.(meeting.meeting_id, folder.folder_id)}>
              <FolderOpen className="h-4 w-4 mr-2" />
              Move to "{folder.name}"
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {children.map(child => renderFolderMenuItem(child, depth + 1))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    } else {
      return (
        <DropdownMenuItem 
          key={folder.folder_id}
          onClick={(e) => onMove?.(meeting.meeting_id, folder.folder_id)}
          className={cn("pl-2", depth > 0 && "pl-4")}
        >
          <Folder className="h-4 w-4 mr-2" />
          {folder.name}
        </DropdownMenuItem>
      );
    }
  };

  return (
    <div
      ref={cardRef}
      draggable
      onDragStart={(e) => onDragStart?.(e, 'meeting', meeting.meeting_id)}
      className={cn(
        'group relative w-full h-[400px] rounded-2xl overflow-hidden transition-all duration-500 ease-out cursor-pointer',
        'hover:shadow-2xl hover:shadow-black/30 hover:-translate-y-2',
        isDragging && 'opacity-50 scale-95',
        // Mobile tap effects (same as hover)
        isHighlighted && [
          'shadow-2xl shadow-black/30 -translate-y-2'
        ],
        className
      )}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      style={{
        background: `
          linear-gradient(135deg, 
            ${statusColors.color}08 0%, 
            ${statusColors.color}03 100%
          ),
          linear-gradient(145deg, 
            rgba(255, 255, 255, 0.1) 0%, 
            rgba(255, 255, 255, 0.05) 100%
          )
        `,
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12)',
        '--mouse-x': '50%',
        '--mouse-y': '50%',
      } as React.CSSProperties}
    >
      {/* Animated border glow */}
      <div 
        className={cn(
          "absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 card-border-glow",
          isHighlighted && "opacity-100"
        )}
        style={{
          background: `
            linear-gradient(135deg, 
              ${statusColors.color}40 0%, 
              ${statusColors.color}20 50%,
              ${statusColors.color}40 100%
            )
          `,
          filter: 'blur(8px)',
          zIndex: -1,
        }}
      />
      
      {/* Spotlight effect */}
      <div 
        className={cn(
          "absolute inset-0 opacity-0 group-hover:opacity-30 transition-opacity duration-300 pointer-events-none",
          isHighlighted && "opacity-30"
        )}
        style={{
          background: `
            radial-gradient(
              200px circle at var(--mouse-x) var(--mouse-y),
              ${statusColors.color}20 0%,
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
              ${statusColors.color}40 35%,
              ${statusColors.color}80 45%,
              ${statusColors.color}60 55%,
              ${statusColors.color}40 65%,
              transparent 80%
            )
          `,
        }}
      />
      
      {/* Content */}
      <div className="relative h-full flex flex-col p-6 z-10">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div 
              className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shadow-lg transition-all duration-300 group-hover:shadow-xl group-hover:scale-105 agent-avatar"
              style={{
                background: `linear-gradient(135deg, ${statusColors.color}25 0%, ${statusColors.color}45 100%)`,
                border: `1px solid ${statusColors.color}40`,
                boxShadow: `0 4px 15px ${statusColors.color}20`,
                '--agent-color': statusColors.color,
              } as React.CSSProperties}
            >
              <FileAudio className="h-6 w-6 text-white" />
              {meeting.status === 'active' && (
                <div className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full shadow-sm animate-pulse" />
              )}
            </div>
            <div>
              <h3 className={cn(
                "text-xl font-semibold text-foreground/90 truncate max-w-[200px] transition-colors duration-300 group-hover:text-foreground",
                isHighlighted && "text-foreground"
              )}>
                {meeting.title}
              </h3>
              <div className="flex items-center gap-2 mt-1">
                <Badge 
                  variant="secondary" 
                  className={cn(
                    "text-xs font-medium transition-all duration-300 shadow-md",
                    statusColors.bgColor,
                    statusColors.textColor,
                    statusColors.borderColor,
                    "group-hover:shadow-lg"
                  )}
                >
                  {meeting.status}
                </Badge>
              </div>
            </div>
          </div>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button 
                variant="ghost" 
                size="sm" 
                className={cn(
                  "opacity-0 group-hover:opacity-100 transition-all duration-200 hover:bg-background/10 h-8 w-8 p-0",
                  isHighlighted && "opacity-100"
                )}
              >
                <MoreHorizontal className="h-4 w-4 text-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={(e) => {
                e.stopPropagation();
                onOpenInChat?.(meeting.meeting_id);
              }}>
                <MessageSquare className="h-4 w-4 mr-2" />
                Open in Chat
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={(e) => {
                e.stopPropagation();
                onEdit?.(meeting.meeting_id, meeting.title);
              }}>
                <Edit2 className="h-4 w-4 mr-2" />
                Rename
              </DropdownMenuItem>
              {folders.length > 0 && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Move className="h-4 w-4 mr-2" />
                    Move to Folder
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={(e) => {
                      e.stopPropagation();
                      onMove?.(meeting.meeting_id, undefined);
                    }}>
                      <FolderOpen className="h-4 w-4 mr-2" />
                      Move to Root
                    </DropdownMenuItem>
                    {buildFolderTree(folders).length > 0 && <DropdownMenuSeparator />}
                    {buildFolderTree(folders).map(f => renderFolderMenuItem(f))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              {meeting.transcript && (
                <DropdownMenuItem onClick={(e) => {
                  e.stopPropagation();
                  onDownloadTranscript?.(meeting);
                }}>
                  <Download className="h-4 w-4 mr-2" />
                  Download Transcript
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={(e) => {
                e.stopPropagation();
                // TODO: Implement sharing
              }}>
                <Share2 className="h-4 w-4 mr-2" />
                Share
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-300"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete?.(meeting.meeting_id);
                }}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Meeting Info */}
        <div className="flex-1 mb-4">
          <div className="space-y-3">
            {/* Date */}
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground group-hover:text-foreground/80 transition-colors duration-300" />
              <span className="text-muted-foreground text-sm group-hover:text-foreground/80 transition-colors duration-300">
                {format(new Date(meeting.created_at), 'MMM d, yyyy h:mm a')}
              </span>
            </div>

            {/* Duration */}
            {meeting.duration && (
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground group-hover:text-foreground/80 transition-colors duration-300" />
                <span className="text-muted-foreground text-sm group-hover:text-foreground/90 transition-colors duration-300">
                  {formatDuration(meeting.duration)}
                </span>
              </div>
            )}

            {/* Participants */}
            {meeting.participant_count && (
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground group-hover:text-foreground/80 transition-colors duration-300" />
                <span className="text-muted-foreground text-sm group-hover:text-foreground/90 transition-colors duration-300">
                  {meeting.participant_count} participant{meeting.participant_count !== 1 ? 's' : ''}
                </span>
              </div>
            )}

            {/* Time ago */}
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm group-hover:text-foreground/85 transition-colors duration-300">
                {formatDistanceToNow(new Date(meeting.created_at), { addSuffix: true })}
              </span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onOpenInChat?.(meeting.meeting_id);
            }}
            size="sm"
            className="flex-1 bg-background/10 hover:bg-background/25 text-foreground border-border/20 backdrop-blur-sm transition-all duration-300 hover:shadow-lg"
            style={{
              boxShadow: `0 4px 15px ${statusColors.color}10`,
            }}
          >
            <MessageSquare className="h-4 w-4 mr-2" />
            Open in Chat
          </Button>
        </div>
      </div>
    </div>
  );
};

const FolderCard: React.FC<FolderProfileCardProps> = ({
  folder,
  className = '',
  onEdit,
  onDelete,
  onNavigate,
  onMove,
  folders = [],
  meetingCount = 0,
  enableTilt = true,
  isDragging = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  dragOverTarget,
  isHighlighted = false,
  onHighlightChange,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const folderColors = getFolderColor();

  // Enhanced tilt effect
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!enableTilt || !cardRef.current) return;
    
    const card = cardRef.current;
    const rect = card.getBoundingClientRect();
    
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    const rotateX = (y - centerY) / 25;
    const rotateY = (centerX - x) / 25;
    
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
          onHighlightChange(isHighlighted ? null : folder.folder_id, 'folder');
        }
      }
      
      touchStartRef.current = null;
    }
  }, [isMobile, onHighlightChange, isHighlighted, folder.folder_id]);

  const handleTouchCancel = useCallback(() => {
    if (isMobile) {
      touchStartRef.current = null;
    }
  }, [isMobile]);

  const buildFolderTree = (folders: MeetingFolder[], parentId?: string): MeetingFolder[] => {
    return folders
      .filter(f => f.parent_folder_id === parentId && f.folder_id !== folder.folder_id)
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const renderFolderMenuItem = (targetFolder: MeetingFolder, depth = 0): React.ReactNode => {
    const children = buildFolderTree(folders, targetFolder.folder_id);
    const hasChildren = children.length > 0;
    
    if (hasChildren) {
      return (
        <DropdownMenuSub key={targetFolder.folder_id}>
          <DropdownMenuSubTrigger className={cn("pl-2", depth > 0 && "pl-4")}>
            <Folder className="h-4 w-4 mr-2" />
            {targetFolder.name}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => onMove?.(folder.folder_id, targetFolder.folder_id)}>
              <FolderOpen className="h-4 w-4 mr-2" />
              Move to "{targetFolder.name}"
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {children.map(child => renderFolderMenuItem(child, depth + 1))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    } else {
      return (
        <DropdownMenuItem 
          key={targetFolder.folder_id}
          onClick={() => onMove?.(folder.folder_id, targetFolder.folder_id)}
          className={cn("pl-2", depth > 0 && "pl-4")}
        >
          <Folder className="h-4 w-4 mr-2" />
          {targetFolder.name}
        </DropdownMenuItem>
      );
    }
  };

  return (
    <div
      ref={cardRef}
      draggable
      onDragStart={(e) => onDragStart?.(e, 'folder', folder.folder_id)}
      onDragOver={(e) => onDragOver?.(e, folder.folder_id)}
      onDragLeave={(e) => onDragLeave?.(e, folder.folder_id)}
      onDrop={(e) => onDrop?.(e, folder.folder_id)}
      onClick={() => onNavigate?.(folder)}
      className={cn(
        'group relative w-full h-[400px] rounded-2xl overflow-hidden transition-all duration-500 ease-out cursor-pointer',
        'hover:shadow-2xl hover:shadow-black/30 hover:-translate-y-2',
        isDragging && 'opacity-50 scale-95',
        dragOverTarget === folder.folder_id && 'bg-blue-500/20 border-blue-400',
        // Mobile tap effects (same as hover)
        isHighlighted && [
          'shadow-2xl shadow-black/30 -translate-y-2'
        ],
        className
      )}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      style={{
        background: `
          linear-gradient(135deg, 
            ${folderColors.color}08 0%, 
            ${folderColors.color}03 100%
          ),
          linear-gradient(145deg, 
            rgba(255, 255, 255, 0.1) 0%, 
            rgba(255, 255, 255, 0.05) 100%
          )
        `,
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12)',
        '--mouse-x': '50%',
        '--mouse-y': '50%',
      } as React.CSSProperties}
    >
      {/* Animated border glow */}
      <div 
        className={cn(
          "absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 card-border-glow",
          isHighlighted && "opacity-100"
        )}
        style={{
          background: `
            linear-gradient(135deg, 
              ${folderColors.color}40 0%, 
              ${folderColors.color}20 50%,
              ${folderColors.color}40 100%
            )
          `,
          filter: 'blur(8px)',
          zIndex: -1,
        }}
      />
      
      {/* Spotlight effect */}
      <div 
        className={cn(
          "absolute inset-0 opacity-0 group-hover:opacity-30 transition-opacity duration-300 pointer-events-none",
          isHighlighted && "opacity-30"
        )}
        style={{
          background: `
            radial-gradient(
              200px circle at var(--mouse-x) var(--mouse-y),
              ${folderColors.color}20 0%,
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
              ${folderColors.color}40 35%,
              ${folderColors.color}80 45%,
              ${folderColors.color}60 55%,
              ${folderColors.color}40 65%,
              transparent 80%
            )
          `,
        }}
      />
      
      {/* Content */}
      <div className="relative h-full flex flex-col p-6 z-10">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div 
              className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shadow-lg transition-all duration-300 group-hover:shadow-xl group-hover:scale-105 agent-avatar"
              style={{
                background: `linear-gradient(135deg, ${folderColors.color}25 0%, ${folderColors.color}45 100%)`,
                border: `1px solid ${folderColors.color}40`,
                boxShadow: `0 4px 15px ${folderColors.color}20`,
                '--agent-color': folderColors.color,
              } as React.CSSProperties}
            >
              <Folder className="h-6 w-6 text-foreground" />
            </div>
            <div>
              <h3 className={cn(
                "text-xl font-semibold text-foreground/90 truncate max-w-[200px] transition-colors duration-300 group-hover:text-foreground",
                isHighlighted && "text-foreground"
              )}>
                {folder.name}
              </h3>
              <div className="flex items-center gap-2 mt-1">
                <Badge 
                  variant="secondary" 
                  className={cn(
                    "text-xs font-medium transition-all duration-300 shadow-md",
                    folderColors.bgColor,
                    folderColors.textColor,
                    folderColors.borderColor,
                    "group-hover:shadow-lg"
                  )}
                >
                  Folder
                </Badge>
              </div>
            </div>
          </div>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button 
                variant="ghost" 
                size="sm" 
                className={cn(
                  "opacity-0 group-hover:opacity-100 transition-all duration-200 hover:bg-background/10 h-8 w-8 p-0",
                  isHighlighted && "opacity-100"
                )}
              >
                <MoreHorizontal className="h-4 w-4 text-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={(e) => {
                e.stopPropagation();
                onEdit?.(folder.folder_id, folder.name);
              }}>
                <Edit2 className="h-4 w-4 mr-2" />
                Rename
              </DropdownMenuItem>
              {folders.length > 0 && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Move className="h-4 w-4 mr-2" />
                    Move to Folder
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={(e) => {
                      e.stopPropagation();
                      onMove?.(folder.folder_id, undefined);
                    }}>
                      <FolderOpen className="h-4 w-4 mr-2" />
                      Move to Root
                    </DropdownMenuItem>
                    {buildFolderTree(folders).length > 0 && <DropdownMenuSeparator />}
                    {buildFolderTree(folders).map(f => renderFolderMenuItem(f))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-300"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete?.(folder.folder_id);
                }}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Folder Info */}
        <div className="flex-1 mb-4">
          <div className="space-y-3">
            {/* Meeting count */}
            <div className="flex items-center gap-2">
              <FileAudio className="h-4 w-4 text-muted-foreground group-hover:text-foreground/80 transition-colors duration-300" />
              <span className="text-muted-foreground text-sm group-hover:text-foreground/90 transition-colors duration-300">
                {meetingCount} meeting{meetingCount !== 1 ? 's' : ''}
              </span>
            </div>

            <div className="text-muted-foreground text-sm group-hover:text-foreground/85 transition-colors duration-300">
              Click to explore this folder
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            onClick={(e) => {
              e.stopPropagation();
              onNavigate?.(folder);
            }}
            size="sm"
            className="flex-1 bg-white/10 hover:bg-white/25 text-white border-white/20 backdrop-blur-sm transition-all duration-300 hover:shadow-lg"
            style={{
              boxShadow: `0 4px 15px ${folderColors.color}10`,
            }}
          >
            <FolderOpen className="h-4 w-4 mr-2" />
            Open Folder
          </Button>
        </div>
      </div>
    </div>
  );
};

export const MeetingProfileCard: React.FC<MeetingCardProps> = (props) => {
  if (props.type === 'meeting') {
    return <MeetingCard {...props} />;
  } else {
    return <FolderCard {...props} />;
  }
};

export default MeetingProfileCard; 