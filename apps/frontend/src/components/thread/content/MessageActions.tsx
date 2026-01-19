'use client';

import React, { useState, useEffect } from 'react';
import { Copy, Check, Volume2, ThumbsUp, ThumbsDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useVoicePlayerStore } from '@/stores/voice-player-store';
import { motion, AnimatePresence } from 'framer-motion';

interface MessageActionsProps {
  text: string;
  className?: string;
}

export function MessageActions({ text, className }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);

  const { playText, state: voiceState } = useVoicePlayerStore();
  const isVoiceLoading = voiceState === 'loading';

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  const handleSpeak = async () => {
    if (!text || isVoiceLoading) return;
    await playText(text);
  };

  const handleLike = () => {
    if (liked) {
      setLiked(false);
    } else {
      setLiked(true);
      setDisliked(false);
    }
  };

  const handleDislike = () => {
    if (disliked) {
      setDisliked(false);
    } else {
      setDisliked(true);
      setLiked(false);
    }
  };

  if (!text?.trim()) return null;

  return (
    <div className={cn('flex items-center gap-1 mt-2', className)}>
      {/* Copy button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground transition-colors"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-foreground" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{copied ? 'Copied!' : 'Copy'}</p>
        </TooltipContent>
      </Tooltip>

      {/* Speaker button - COMMENTED OUT */}
      {/* <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground transition-colors"
            onClick={handleSpeak}
            disabled={isVoiceLoading}
          >
            {isVoiceLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{isVoiceLoading ? 'Generating...' : 'Listen'}</p>
        </TooltipContent>
      </Tooltip> */}

      {/* Thumbs up - with animation */}
      <AnimatePresence mode="popLayout">
        {!disliked && (
          <motion.div
            initial={{ opacity: 0, scale: 0.5, width: 0 }}
            animate={{ opacity: 1, scale: 1, width: 'auto' }}
            exit={{ opacity: 0, scale: 0.5, width: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-7 w-7 transition-colors',
                    liked
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={handleLike}
                >
                  <ThumbsUp
                    className="h-3.5 w-3.5"
                    fill={liked ? 'currentColor' : 'none'}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{liked ? 'Remove rating' : 'Good response'}</p>
              </TooltipContent>
            </Tooltip>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Thumbs down - with animation */}
      <AnimatePresence mode="popLayout">
        {!liked && (
          <motion.div
            initial={{ opacity: 0, scale: 0.5, width: 0 }}
            animate={{ opacity: 1, scale: 1, width: 'auto' }}
            exit={{ opacity: 0, scale: 0.5, width: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-7 w-7 transition-colors',
                    disliked
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={handleDislike}
                >
                  <ThumbsDown
                    className="h-3.5 w-3.5"
                    fill={disliked ? 'currentColor' : 'none'}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{disliked ? 'Remove rating' : 'Bad response'}</p>
              </TooltipContent>
            </Tooltip>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
