import React, { useCallback, useEffect, useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Play, Pause, ArrowDown, FileText, Info } from 'lucide-react';
import { UnifiedMessage } from '@/components/thread/types';
import { safeJsonParse } from '@/components/thread/utils';
import Link from 'next/link';

// Define the set of tags whose raw XML should be hidden during streaming
const HIDE_STREAMING_XML_TAGS = new Set([
  'execute-command',
  'create-file',
  'delete-file',
  'full-file-rewrite',
  'edit-file',
  'str-replace',
  'browser-click-element',
  'browser-close-tab',
  'browser-drag-drop',
  'browser-get-dropdown-options',
  'browser-go-back',
  'browser-input-text',
  'browser-navigate-to',
  'browser-scroll-down',
  'browser-scroll-to-text',
  'browser-scroll-up',
  'browser-select-dropdown-option',
  'browser-send-keys',
  'browser-switch-tab',
  'browser-wait',
  'deploy',
  'ask',
  'complete',
  'crawl-webpage',
  'web-search',
]);

export interface PlaybackControlsProps {
  messages: UnifiedMessage[];
  isSidePanelOpen: boolean;
  onToggleSidePanel: () => void;
  toolCalls: any[];
  setCurrentToolIndex: (index: number) => void;
  onFileViewerOpen: () => void;
  projectName?: string;
}

export interface PlaybackState {
  isPlaying: boolean;
  currentMessageIndex: number;
  visibleMessages: UnifiedMessage[];
  streamingText: string;
  isStreamingText: boolean;
  currentToolCall: any | null;
  toolPlaybackIndex: number;
}

export interface PlaybackController {
  playbackState: PlaybackState;
  updatePlaybackState: (updates: Partial<PlaybackState>) => void;
  renderHeader: () => JSX.Element;
  renderFloatingControls: () => JSX.Element;
  renderWelcomeOverlay: () => JSX.Element;
  togglePlayback: () => void;
  resetPlayback: () => void;
  skipToEnd: () => void;
}

export const PlaybackControls = ({
  messages,
  isSidePanelOpen,
  onToggleSidePanel,
  toolCalls,
  setCurrentToolIndex,
  onFileViewerOpen,
  projectName = 'Shared Conversation',
}: PlaybackControlsProps): PlaybackController => {
  const [playbackState, setPlaybackState] = useState<PlaybackState>({
    isPlaying: false,
    currentMessageIndex: 0,
    visibleMessages: [],
    streamingText: '',
    isStreamingText: false,
    currentToolCall: null,
    toolPlaybackIndex: -1,
  });

  // Extract state variables for easier access
  const {
    isPlaying,
    currentMessageIndex,
    visibleMessages,
    streamingText,
    isStreamingText,
    currentToolCall,
    toolPlaybackIndex,
  } = playbackState;

  // Helper function to update playback state
  const updatePlaybackState = useCallback((updates: Partial<PlaybackState>) => {
    setPlaybackState((prev) => ({ ...prev, ...updates }));
  }, []);

  // Define togglePlayback and resetPlayback functions
  const togglePlayback = useCallback(() => {
    updatePlaybackState({
      isPlaying: !isPlaying,
    });

    // When starting playback, show the side panel
    if (!isPlaying && !isSidePanelOpen) {
      onToggleSidePanel();
    }
  }, [isPlaying, isSidePanelOpen, onToggleSidePanel, updatePlaybackState]);

  const resetPlayback = useCallback(() => {
    updatePlaybackState({
      isPlaying: false,
      currentMessageIndex: 0,
      visibleMessages: [],
      streamingText: '',
      isStreamingText: false,
      currentToolCall: null,
      toolPlaybackIndex: -1,
    });
    if (isSidePanelOpen) {
      onToggleSidePanel();
    }
  }, [updatePlaybackState, isSidePanelOpen, onToggleSidePanel]);

  const skipToEnd = useCallback(() => {
    updatePlaybackState({
      isPlaying: false,
      currentMessageIndex: messages.length,
      visibleMessages: messages,
      streamingText: '',
      isStreamingText: false,
      currentToolCall: null,
      toolPlaybackIndex: toolCalls.length - 1,
    });

    if (toolCalls.length > 0) {
      setCurrentToolIndex(toolCalls.length - 1);
      if (!isSidePanelOpen) {
        onToggleSidePanel();
      }
    }
  }, [
    messages,
    toolCalls,
    isSidePanelOpen,
    onToggleSidePanel,
    setCurrentToolIndex,
    updatePlaybackState,
  ]);

  // Streaming text function
  const streamText = useCallback(
    (text: string, onComplete: () => void) => {
      if (!text || !isPlaying) {
        onComplete();
        return () => {};
      }

      updatePlaybackState({
        isStreamingText: true,
        streamingText: '',
      });

      // Define regex to find tool calls in text
      const toolCallRegex =
        /<([a-zA-Z\-_]+)(?:\s+[^>]*)?>(?:[\s\S]*?)<\/\1>|<([a-zA-Z\-_]+)(?:\s+[^>]*)?\/>/g;

      // Split text into chunks (handling tool calls as special chunks)
      const chunks: { text: string; isTool: boolean; toolName?: string }[] = [];
      let lastIndex = 0;
      let match;

      while ((match = toolCallRegex.exec(text)) !== null) {
        // Add text before the tool call
        if (match.index > lastIndex) {
          chunks.push({
            text: text.substring(lastIndex, match.index),
            isTool: false,
          });
        }

        // Add the tool call
        const toolName = match[1] || match[2];
        chunks.push({
          text: match[0],
          isTool: true,
          toolName,
        });

        lastIndex = toolCallRegex.lastIndex;
      }

      // Add any remaining text after the last tool call
      if (lastIndex < text.length) {
        chunks.push({
          text: text.substring(lastIndex),
          isTool: false,
        });
      }

      let currentIndex = 0;
      let chunkIndex = 0;
      let currentText = '';
      let isPaused = false;

      const processNextCharacter = () => {
        // Check if component is unmounted or playback is stopped
        if (!isPlaying || isPaused) {
          setTimeout(processNextCharacter, 100); // Check again after a short delay
          return;
        }

        if (chunkIndex >= chunks.length) {
          // All chunks processed, we're done
          updatePlaybackState({
            isStreamingText: false,
          });

          // Update visible messages with the complete message
          const currentMessage = messages[currentMessageIndex];
          const lastMessage = visibleMessages[visibleMessages.length - 1];

          if (lastMessage?.message_id === currentMessage.message_id) {
            // Replace the streaming message with the complete one
            updatePlaybackState({
              visibleMessages: [
                ...visibleMessages.slice(0, -1),
                currentMessage,
              ],
            });
          } else {
            // Add the complete message
            updatePlaybackState({
              visibleMessages: [...visibleMessages, currentMessage],
            });
          }

          onComplete();
          return;
        }

        const currentChunk = chunks[chunkIndex];

        // If this is a tool call chunk and we're at the start of it
        if (currentChunk.isTool && currentIndex === 0) {
          // For tool calls, check if they should be hidden during streaming
          if (
            currentChunk.toolName &&
            HIDE_STREAMING_XML_TAGS.has(currentChunk.toolName)
          ) {
            // Instead of showing the XML, create a tool call object
            const toolCall = {
              name: currentChunk.toolName,
              arguments: currentChunk.text,
              xml_tag_name: currentChunk.toolName,
            };

            updatePlaybackState({
              currentToolCall: toolCall,
              toolPlaybackIndex: toolPlaybackIndex + 1,
            });

            if (!isSidePanelOpen) {
              onToggleSidePanel();
            }

            setCurrentToolIndex(toolPlaybackIndex + 1);

            // Pause streaming briefly while showing the tool
            isPaused = true;
            setTimeout(() => {
              isPaused = false;
              updatePlaybackState({ currentToolCall: null });
              chunkIndex++; // Move to next chunk
              currentIndex = 0; // Reset index for next chunk
              processNextCharacter();
            }, 500); // Reduced from 1500ms to 500ms pause for tool display

            return;
          }
        }

        // Handle normal text streaming for non-tool chunks or visible tool chunks
        if (currentIndex < currentChunk.text.length) {
          // Dynamically adjust typing speed for a more realistic effect
          const baseDelay = 5; // Reduced from 15ms to 5ms
          let typingDelay = baseDelay;

          // Add more delay for punctuation to make it feel more natural
          const char = currentChunk.text[currentIndex];
          if ('.!?,;:'.includes(char)) {
            typingDelay = baseDelay + Math.random() * 100 + 50; // Reduced from 300+100 to 100+50ms pause after punctuation
          } else {
            const variableDelay = Math.random() * 5; // Reduced from 15 to 5ms
            typingDelay = baseDelay + variableDelay; // 5-10ms for normal typing
          }

          // Add the next character
          currentText += currentChunk.text[currentIndex];
          updatePlaybackState({ streamingText: currentText });
          currentIndex++;

          // Process next character with dynamic delay
          setTimeout(processNextCharacter, typingDelay);
        } else {
          // Move to the next chunk
          chunkIndex++;
          currentIndex = 0;
          processNextCharacter();
        }
      };

      processNextCharacter();

      // Return cleanup function
      return () => {
        updatePlaybackState({
          isStreamingText: false,
          streamingText: '',
        });
        isPaused = true; // Stop processing
      };
    },
    [
      isPlaying,
      messages,
      currentMessageIndex,
      toolPlaybackIndex,
      setCurrentToolIndex,
      isSidePanelOpen,
      onToggleSidePanel,
      updatePlaybackState,
      visibleMessages,
    ],
  );

  // Main playback function
  useEffect(() => {
    if (!isPlaying || messages.length === 0) return;

    let playbackTimeout: NodeJS.Timeout;
    let cleanupStreaming: (() => void) | undefined;

    const playbackNextMessage = async () => {
      // Ensure we're within bounds
      if (currentMessageIndex >= messages.length) {
        updatePlaybackState({ isPlaying: false });
        return;
      }

      const currentMessage = messages[currentMessageIndex];
      console.log(
        `Playing message ${currentMessageIndex}:`,
        currentMessage.type,
        currentMessage.message_id,
      );

      // If it's an assistant message, stream it
      if (currentMessage.type === 'assistant') {
        try {
          // Parse the content if it's JSON
          let content = currentMessage.content;
          try {
            const parsed = JSON.parse(content);
            if (parsed.content) {
              content = parsed.content;
            }
          } catch (e) {
            // Not JSON, use as is
          }

          // Stream the message content
          await new Promise<void>((resolve) => {
            cleanupStreaming = streamText(content, resolve);
          });
        } catch (error) {
          console.error('Error streaming message:', error);
        }
      } else {
        // For non-assistant messages, just add them to visible messages
        updatePlaybackState({
          visibleMessages: [...visibleMessages, currentMessage],
        });

        // Wait a moment before showing the next message
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Move to the next message
      updatePlaybackState({
        currentMessageIndex: currentMessageIndex + 1,
      });
    };

    // Start playback with a small delay
    playbackTimeout = setTimeout(playbackNextMessage, 500);

    return () => {
      clearTimeout(playbackTimeout);
      if (cleanupStreaming) cleanupStreaming();
    };
  }, [
    isPlaying,
    currentMessageIndex,
    messages,
    streamText,
    updatePlaybackState,
    visibleMessages,
  ]);

  // Floating playback controls position based on side panel state
  const controlsPositionClass = isSidePanelOpen
    ? 'left-1/2 -translate-x-1/4 sm:left-[calc(50%-225px)] md:left-[calc(50%-250px)] lg:left-[calc(50%-275px)] xl:left-[calc(50%-325px)]'
    : 'left-1/2 -translate-x-1/2';

  // Header with playback controls
  const renderHeader = useCallback(
    () => (
      <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 relative z-[50]">
        <div className="flex h-14 items-center gap-4 px-4">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center w-6 h-6 rounded-md overflow-hidden bg-primary/10">
                <Link href="/">
                  <img
                    src="/kortix-symbol.svg"
                    alt="Kortix"
                    width={16}
                    height={16}
                    className="object-contain"
                  />
                </Link>
              </div>
              <h1>
                <span className="font-medium text-foreground">
                  {projectName}
                </span>
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={onFileViewerOpen}
              className="h-8 w-8"
              aria-label="View Files"
            >
              <FileText className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={togglePlayback}
              className="h-8 w-8"
              aria-label={isPlaying ? 'Pause Replay' : 'Play Replay'}
            >
              {isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={resetPlayback}
              className="h-8 w-8"
              aria-label="Restart Replay"
            >
              <ArrowDown className="h-4 w-4 rotate-90" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleSidePanel}
              className={`h-8 w-8 ${isSidePanelOpen ? 'text-primary' : ''}`}
              aria-label="Toggle Tool Panel"
            >
              <Info className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    ),
    [
      isPlaying,
      isSidePanelOpen,
      onFileViewerOpen,
      onToggleSidePanel,
      projectName,
      resetPlayback,
      togglePlayback,
    ],
  );

  const renderFloatingControls = useCallback(
    () => (
      <>
        {messages.length > 0 && (
          <div
            className={`fixed bottom-4 z-10 transform bg-background/90 backdrop-blur rounded-full border shadow-md px-3 py-1.5 transition-all duration-200 ${controlsPositionClass}`}
          >
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={togglePlayback}
                className="h-8 w-8"
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </Button>

              <div className="flex items-center text-xs text-muted-foreground">
                <span>
                  {Math.min(
                    currentMessageIndex + (isStreamingText ? 0 : 1),
                    messages.length,
                  )}
                  /{messages.length}
                </span>
              </div>

              <Button
                variant="ghost"
                size="icon"
                onClick={resetPlayback}
                className="h-8 w-8"
              >
                <ArrowDown className="h-4 w-4 rotate-90" />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={skipToEnd}
                className="text-xs"
              >
                Skip to end
              </Button>
            </div>
          </div>
        )}
      </>
    ),
    [
      controlsPositionClass,
      currentMessageIndex,
      isPlaying,
      isStreamingText,
      messages.length,
      resetPlayback,
      skipToEnd,
      togglePlayback,
    ],
  );

  // When s are displayed yet, show the welcome overlay
  const renderWelcomeOverlay = useCallback(
    () => (
      <>
        {visibleMessages.length === 0 && !streamingText && !currentToolCall && (
          <div className="fixed inset-0 flex flex-col items-center justify-center">
            {/* Gradient overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent dark:from-black/90 dark:via-black/50 dark:to-transparent" />

            <div className="text-center max-w-md mx-auto relative z-10 px-4">
              <div className="rounded-full bg-primary/10 backdrop-blur-sm w-12 h-12 mx-auto flex items-center justify-center mb-4">
                <Play className="h-5 w-5 text-primary" />
              </div>
              <h3 className="text-lg font-medium mb-2 text-white">
                Watch this agent in action
              </h3>
              <p className="text-sm text-white/80 mb-4">
                This is a shared view-only agent run. Click play to replay the
                entire conversation with realistic timing.
              </p>
              <Button
                onClick={togglePlayback}
                className="flex items-center mx-auto bg-white/10 hover:bg-white/20 backdrop-blur-sm text-white border-white/20"
                size="lg"
                variant="outline"
              >
                <Play className="h-4 w-4 mr-2" />
                Start Playback
              </Button>
            </div>
          </div>
        )}
      </>
    ),
    [currentToolCall, streamingText, togglePlayback, visibleMessages.length],
  );

  return {
    playbackState,
    updatePlaybackState,
    renderHeader,
    renderFloatingControls,
    renderWelcomeOverlay,
    togglePlayback,
    resetPlayback,
    skipToEnd,
  };
};

export default PlaybackControls;
