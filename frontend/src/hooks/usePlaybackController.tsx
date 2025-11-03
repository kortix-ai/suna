import { useCallback, useEffect, useReducer, useRef } from 'react';
import { UnifiedMessage } from '@/components/thread/types';

export interface PlaybackState {
    isPlaying: boolean;
    currentMessageIndex: number;
    visibleMessages: UnifiedMessage[];
    streamingText: string;
    isStreamingText: boolean;
    currentToolCall: any | null;
}

type PlaybackAction =
    | { type: 'TOGGLE_PLAYBACK' }
    | { type: 'START_PLAYBACK' }
    | { type: 'RESET' }
    | { type: 'SKIP_TO_END'; messages: UnifiedMessage[] }
    | { type: 'FORWARD_ONE'; messages: UnifiedMessage[] }
    | { type: 'BACKWARD_ONE' }
    | { type: 'SET_VISIBLE_MESSAGES'; messages: UnifiedMessage[] }
    | { type: 'SET_STREAMING_TEXT'; text: string }
    | { type: 'SET_IS_STREAMING'; value: boolean }
    | { type: 'SET_CURRENT_MESSAGE_INDEX'; index: number }
    | { type: 'SET_CURRENT_TOOL_CALL'; toolCall: any | null }
    | { type: 'STOP_PLAYBACK' };

function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
    switch (action.type) {
        case 'TOGGLE_PLAYBACK':
            return { ...state, isPlaying: !state.isPlaying };
        case 'START_PLAYBACK':
            return { ...state, isPlaying: true };
        case 'RESET':
            return {
                isPlaying: false,
                currentMessageIndex: 0,
                visibleMessages: [],
                streamingText: '',
                isStreamingText: false,
                currentToolCall: null,
            };
        case 'SKIP_TO_END':
            return {
                ...state,
                isPlaying: false,
                currentMessageIndex: action.messages.length,
                visibleMessages: action.messages,
                streamingText: '',
                isStreamingText: false,
                currentToolCall: null,
            };
        case 'FORWARD_ONE': {
            const nextIndex = Math.min(state.currentMessageIndex + 1, action.messages.length);
            return {
                ...state,
                currentMessageIndex: nextIndex,
                visibleMessages: action.messages.slice(0, nextIndex),
                streamingText: '',
                isStreamingText: false,
            };
        }
        case 'BACKWARD_ONE': {
            const prevIndex = Math.max(0, state.currentMessageIndex - 1);
            return {
                ...state,
                currentMessageIndex: prevIndex,
                visibleMessages: state.visibleMessages.slice(0, prevIndex),
                streamingText: '',
                isStreamingText: false,
            };
        }
        case 'SET_VISIBLE_MESSAGES':
            return { ...state, visibleMessages: action.messages };
        case 'SET_STREAMING_TEXT':
            return { ...state, streamingText: action.text };
        case 'SET_IS_STREAMING':
            return { ...state, isStreamingText: action.value };
        case 'SET_CURRENT_MESSAGE_INDEX':
            return { ...state, currentMessageIndex: action.index };
        case 'SET_CURRENT_TOOL_CALL':
            return { ...state, currentToolCall: action.toolCall };
        case 'STOP_PLAYBACK':
            return { ...state, isPlaying: false };
        default:
            return state;
    }
}

interface UsePlaybackControllerOptions {
    messages: UnifiedMessage[];
    enabled: boolean;
    isSidePanelOpen: boolean;
    onToggleSidePanel: () => void;
    setCurrentToolIndex: (index: number) => void;
    toolCalls: any[];
}

export function usePlaybackController({
    messages,
    enabled,
    isSidePanelOpen,
    onToggleSidePanel,
    setCurrentToolIndex,
    toolCalls,
}: UsePlaybackControllerOptions) {
    const [state, dispatch] = useReducer(playbackReducer, {
        isPlaying: false,
        currentMessageIndex: 0,
        visibleMessages: messages.length > 0 ? [messages[0]] : [],
        streamingText: '',
        isStreamingText: false,
        currentToolCall: null,
    });

    // Refs to avoid stale closures
    const stateRef = useRef(state);
    const messagesRef = useRef(messages);
    const streamCleanupRef = useRef<(() => void) | null>(null);
    const playbackLoopRef = useRef<boolean>(false);

    // Keep refs in sync
    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    // Initialize with first message when messages load
    useEffect(() => {
        if (enabled && messages.length > 0 && state.visibleMessages.length === 0) {
            dispatch({ type: 'SET_VISIBLE_MESSAGES', messages: [messages[0]] });
        }
    }, [enabled, messages.length, state.visibleMessages.length]);

    // Stream text character by character with realistic typing animation
    const streamText = useCallback((text: string, onComplete: () => void) => {
        if (!text) {
            onComplete();
            return () => { };
        }

        // Check if playback is still active
        if (!stateRef.current.isPlaying) {
            onComplete();
            return () => { };
        }

        const textStr = typeof text === 'string' ? text : String(text);

        dispatch({ type: 'SET_IS_STREAMING', value: true });
        dispatch({ type: 'SET_STREAMING_TEXT', text: '' });

        let currentIndex = 0;
        let currentText = '';
        let isCancelled = false;

        const streamNextChar = () => {

            if (isCancelled || !stateRef.current.isPlaying) {
                dispatch({ type: 'SET_IS_STREAMING', value: false });
                onComplete();
                return;
            }

            if (currentIndex < textStr.length) {
                // Dynamically adjust typing speed for realistic effect
                const baseDelay = 2; // Base typing speed: 2ms (faster!)
                let typingDelay = baseDelay;

                // Add more delay for punctuation to make it feel natural
                const char = textStr[currentIndex];
                if ('.!?,;:'.includes(char)) {
                    // Pause after punctuation (30-50ms) - much shorter
                    typingDelay = baseDelay + Math.random() * 20 + 30;
                } else {
                    // Random variation for normal typing (2-4ms) - faster!
                    const variableDelay = Math.random() * 2;
                    typingDelay = baseDelay + variableDelay;
                }

                // Add the next character
                currentText += char;

                dispatch({ type: 'SET_STREAMING_TEXT', text: currentText });
                currentIndex++;

                // Process next character with dynamic delay
                setTimeout(streamNextChar, typingDelay);
            } else {
                // Finished streaming - add the complete message to visibleMessages
                dispatch({ type: 'SET_IS_STREAMING', value: false });

                const currentState = stateRef.current;
                const currentMessageIndex = currentState.currentMessageIndex;
                const currentMessage = messagesRef.current[currentMessageIndex];
                const lastMessage = currentState.visibleMessages[currentState.visibleMessages.length - 1];

                if (lastMessage?.message_id === currentMessage.message_id) {
                    // Replace the streaming message with the complete one
                    dispatch({
                        type: 'SET_VISIBLE_MESSAGES',
                        messages: [...currentState.visibleMessages.slice(0, -1), currentMessage]
                    });
                } else {
                    // Add the complete message
                    dispatch({
                        type: 'SET_VISIBLE_MESSAGES',
                        messages: [...currentState.visibleMessages, currentMessage]
                    });
                }

                dispatch({ type: 'SET_STREAMING_TEXT', text: '' });
                onComplete();
            }
        };

        streamNextChar();

        // Return cleanup function
        return () => {
            isCancelled = true;
            dispatch({ type: 'SET_IS_STREAMING', value: false });
        };
    }, []);

    // Main playback loop - ONLY runs when isPlaying changes
    useEffect(() => {
        if (!enabled || !state.isPlaying || messages.length === 0) {
            return;
        }

        let isCancelled = false;
        playbackLoopRef.current = true;

        const runPlayback = async () => {
            while (!isCancelled && stateRef.current.isPlaying && playbackLoopRef.current) {
                const currentState = stateRef.current;
                const msgIndex = currentState.currentMessageIndex;
                const currentMessages = messagesRef.current;

                // Check if we're done
                if (msgIndex >= currentMessages.length) {
                    dispatch({ type: 'STOP_PLAYBACK' });
                    break;
                }

                const currentMessage = currentMessages[msgIndex];

                // Skip if already visible (first message on autoplay)
                const isAlreadyVisible = currentState.visibleMessages.some(
                    (m) => m.message_id === currentMessage.message_id
                );

                if (isAlreadyVisible && msgIndex === 0) {
                    dispatch({ type: 'SET_CURRENT_MESSAGE_INDEX', index: msgIndex + 1 });
                    await new Promise(resolve => setTimeout(resolve, 100));
                    continue;
                }

                // Stream assistant messages
                if (currentMessage.type === 'assistant') {
                    try {
                        let content = currentMessage.content;
                        console.log('[Playback] Raw message.content:', typeof content, content);

                        let textToStream = '';

                        // Handle different content formats
                        if (typeof content === 'string') {
                            // If it's a string, try to parse it as JSON
                            try {
                                const parsed = JSON.parse(content);
                                console.log('[Playback] Parsed JSON from string:', parsed);
                                if (parsed.content) {
                                    textToStream = parsed.content;
                                } else {
                                    textToStream = content;
                                }
                            } catch (e) {
                                // Not JSON, use as-is
                                console.log('[Playback] Not JSON, using string as-is');
                                textToStream = content;
                            }
                        } else if (typeof content === 'object' && content !== null) {
                            // If it's already an object, extract the content field
                            console.log('[Playback] Content is object, extracting content field');
                            textToStream = (content as any).content || '';
                        }

                        console.log('[Playback] Starting to stream assistant message. Text length:', textToStream.length, 'First 50:', textToStream.substring(0, 50));

                        // Stream the text (will update streamingText state character by character)
                        await new Promise<void>((resolve) => {
                            const cleanup = streamText(textToStream, resolve);
                            streamCleanupRef.current = cleanup;
                        });

                        console.log('[Playback] Finished streaming');

                        if (isCancelled) break;
                    } catch (error) {
                        console.error('Error streaming message:', error);
                    }
                } else {
                    // Non-assistant messages: show immediately
                    console.log('[Playback] Adding user/other message immediately');
                    dispatch({
                        type: 'SET_VISIBLE_MESSAGES',
                        messages: [...currentState.visibleMessages, currentMessage],
                    });

                    await new Promise(resolve => setTimeout(resolve, 300));
                }

                if (isCancelled) break;

                // Move to next message
                dispatch({ type: 'SET_CURRENT_MESSAGE_INDEX', index: msgIndex + 1 });

                // Delay between messages
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            playbackLoopRef.current = false;
        };

        runPlayback();

        return () => {
            isCancelled = true;
            playbackLoopRef.current = false;
            if (streamCleanupRef.current) {
                streamCleanupRef.current();
                streamCleanupRef.current = null;
            }
        };
    }, [enabled, state.isPlaying, messages.length, streamText]);

    // Control functions
    const togglePlayback = useCallback(() => {
        dispatch({ type: 'TOGGLE_PLAYBACK' });
        if (!state.isPlaying && !isSidePanelOpen) {
            onToggleSidePanel();
        }
    }, [state.isPlaying, isSidePanelOpen, onToggleSidePanel]);

    const resetPlayback = useCallback(() => {
        if (streamCleanupRef.current) {
            streamCleanupRef.current();
            streamCleanupRef.current = null;
        }
        dispatch({ type: 'RESET' });
        if (isSidePanelOpen) {
            onToggleSidePanel();
        }
    }, [isSidePanelOpen, onToggleSidePanel]);

    const skipToEnd = useCallback(() => {
        if (streamCleanupRef.current) {
            streamCleanupRef.current();
            streamCleanupRef.current = null;
        }
        dispatch({ type: 'SKIP_TO_END', messages });
        if (toolCalls.length > 0 && !isSidePanelOpen) {
            setCurrentToolIndex(toolCalls.length - 1);
            onToggleSidePanel();
        }
    }, [messages, toolCalls, isSidePanelOpen, setCurrentToolIndex, onToggleSidePanel]);

    const forwardOne = useCallback(() => {
        if (streamCleanupRef.current) {
            streamCleanupRef.current();
            streamCleanupRef.current = null;
        }
        dispatch({ type: 'FORWARD_ONE', messages });
    }, [messages]);

    const backwardOne = useCallback(() => {
        if (streamCleanupRef.current) {
            streamCleanupRef.current();
            streamCleanupRef.current = null;
        }
        dispatch({ type: 'BACKWARD_ONE' });
    }, []);

    // Auto-start playback after a delay when first loaded
    useEffect(() => {
        if (enabled && messages.length > 0 && state.currentMessageIndex === 0 && !state.isPlaying) {
            const autoStartTimer = setTimeout(() => {
                dispatch({ type: 'START_PLAYBACK' });
                if (!isSidePanelOpen) {
                    onToggleSidePanel();
                }
            }, 500); // 500ms delay to let first message load

            return () => clearTimeout(autoStartTimer);
        }
    }, [enabled, messages.length, state.currentMessageIndex, state.isPlaying, isSidePanelOpen, onToggleSidePanel]);

    return {
        playbackState: {
            ...state,
            // When streaming, show only previous messages (not the currently streaming one)
            // The streaming text will be rendered separately via streamingText prop
            displayMessages: state.isStreamingText
                ? state.visibleMessages
                : state.visibleMessages,
        },
        togglePlayback,
        resetPlayback,
        skipToEnd,
        forwardOne,
        backwardOne,
    };
}
