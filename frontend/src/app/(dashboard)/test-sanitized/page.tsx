'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

// TypeScript interfaces for sanitized message format
interface SanitizedMessage {
  message_id: string | null;
  type: 'user' | 'assistant_text' | 'tool_call' | 'tool_result' | 'status' | 'system';
  created_at?: string;
  updated_at?: string;
  sequence?: number;
  streaming?: boolean;
  content: any;
  metadata?: any;
}

interface GetMessagesResponse {
  messages: SanitizedMessage[];
  metadata: {
    total_count: number;
    has_more: boolean;
    order: string;
  };
}

export default function SanitizedAPITest() {
  const [threadId, setThreadId] = useState('');
  const [agentRunId, setAgentRunId] = useState('');
  const [messages, setMessages] = useState<SanitizedMessage[]>([]);
  const [streamingMessages, setStreamingMessages] = useState<SanitizedMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Test GET endpoint
  const fetchFormattedMessages = async () => {
    if (!threadId.trim()) {
      setError('Please enter a thread ID');
      return;
    }

    setLoading(true);
    setError(null);
    setMessages([]);

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/threads/${threadId}/messages/formatted`,
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: GetMessagesResponse = await response.json();
      setMessages(data.messages);
      console.log('[SANITIZED API] Fetched formatted messages:', data);
    } catch (err) {
      console.error('[SANITIZED API] Error fetching messages:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch messages');
    } finally {
      setLoading(false);
    }
  };

  // Test Stream endpoint
  const startFormattedStream = async () => {
    if (!agentRunId.trim()) {
      setError('Please enter an agent run ID');
      return;
    }

    setStreaming(true);
    setError(null);
    setStreamingMessages([]);

    try {
      const token = localStorage.getItem('access_token');
      const url = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/agent-run/${agentRunId}/stream/formatted${token ? `?token=${token}` : ''}`;

      const eventSource = new EventSource(url);

      eventSource.onmessage = (event) => {
        try {
          const message: SanitizedMessage = JSON.parse(event.data);
          console.log('[SANITIZED API] Received streaming message:', message);
          
          setStreamingMessages((prev) => {
            // Handle streaming updates
            if (message.streaming && message.message_id === null) {
              // This is a chunk - append to previous message if same type
              const last = prev[prev.length - 1];
              if (last && last.type === message.type && last.streaming) {
                // Update the last message with new content
                return [
                  ...prev.slice(0, -1),
                  {
                    ...last,
                    content: {
                      ...last.content,
                      text: (last.content.text || '') + (message.content.text || ''),
                    },
                  },
                ];
              }
            }
            // New message or complete message
            return [...prev, message];
          });

          // Check for completion
          if (message.type === 'status' && message.content?.status_type === 'completed') {
            eventSource.close();
            setStreaming(false);
          }
        } catch (err) {
          console.error('[SANITIZED API] Error parsing stream message:', err);
        }
      };

      eventSource.onerror = (err) => {
        console.error('[SANITIZED API] Stream error:', err);
        setError('Stream connection error');
        eventSource.close();
        setStreaming(false);
      };

      // Cleanup on unmount
      return () => {
        eventSource.close();
        setStreaming(false);
      };
    } catch (err) {
      console.error('[SANITIZED API] Error starting stream:', err);
      setError(err instanceof Error ? err.message : 'Failed to start stream');
      setStreaming(false);
    }
  };

  // Render a single message
  const renderMessage = (msg: SanitizedMessage, index: number) => {
    const bgColor = {
      user: 'bg-blue-50 dark:bg-blue-950',
      assistant_text: 'bg-green-50 dark:bg-green-950',
      tool_call: 'bg-yellow-50 dark:bg-yellow-950',
      tool_result: 'bg-purple-50 dark:bg-purple-950',
      status: 'bg-gray-50 dark:bg-gray-900',
      system: 'bg-red-50 dark:bg-red-950',
    };

    return (
      <Card key={index} className={`p-4 mb-2 ${bgColor[msg.type] || 'bg-gray-50'}`}>
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm uppercase">{msg.type}</span>
            {msg.streaming && (
              <span className="text-xs bg-blue-500 text-white px-2 py-0.5 rounded">
                STREAMING
              </span>
            )}
          </div>
          {msg.message_id && (
            <span className="text-xs text-muted-foreground">{msg.message_id}</span>
          )}
        </div>

        <div className="space-y-2">
          {/* Render content based on type */}
          {msg.type === 'user' && (
            <div>
              <p className="text-sm">{msg.content.text}</p>
              {msg.content.attachments?.length > 0 && (
                <div className="text-xs text-muted-foreground mt-1">
                  Attachments: {msg.content.attachments.length}
                </div>
              )}
            </div>
          )}

          {msg.type === 'assistant_text' && (
            <div>
              <p className="text-sm whitespace-pre-wrap">{msg.content.text}</p>
              {msg.metadata?.agent_name && (
                <div className="text-xs text-muted-foreground mt-1">
                  Agent: {msg.metadata.agent_name}
                </div>
              )}
            </div>
          )}

          {msg.type === 'tool_call' && (
            <div>
              <div className="text-sm font-mono">
                <span className="font-semibold">{msg.content.tool_name}</span>
              </div>
              <pre className="text-xs mt-2 p-2 bg-black/5 dark:bg-white/5 rounded overflow-x-auto">
                {JSON.stringify(msg.content.parameters, null, 2)}
              </pre>
            </div>
          )}

          {msg.type === 'tool_result' && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-mono">{msg.content.tool_name}</span>
                {msg.content.success ? (
                  <span className="text-xs text-green-600">✓ Success</span>
                ) : (
                  <span className="text-xs text-red-600">✗ Error</span>
                )}
              </div>
              <div className="text-xs mt-1 p-2 bg-black/5 dark:bg-white/5 rounded overflow-x-auto max-h-48 overflow-y-auto">
                {typeof msg.content.result === 'string'
                  ? msg.content.result
                  : JSON.stringify(msg.content.result, null, 2)}
              </div>
              {msg.content.error && (
                <div className="text-xs text-red-600 mt-1">{msg.content.error}</div>
              )}
            </div>
          )}

          {msg.type === 'status' && (
            <div className="text-sm">
              <span className="font-semibold">{msg.content.status_type}:</span>{' '}
              {msg.content.message}
            </div>
          )}

          {msg.type === 'system' && (
            <div className="text-sm">{msg.content.text}</div>
          )}
        </div>

        {msg.created_at && (
          <div className="text-xs text-muted-foreground mt-2">
            {new Date(msg.created_at).toLocaleString()}
          </div>
        )}
      </Card>
    );
  };

  return (
    <div className="container mx-auto p-8 max-w-6xl">
      <h1 className="text-3xl font-bold mb-2">Sanitized API Test Page</h1>
      <p className="text-muted-foreground mb-8">
        Test the new formatted message endpoints that return frontend-ready data
      </p>

      {error && (
        <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* GET Endpoint Test */}
        <div>
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-4">Test GET Endpoint</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Fetch formatted messages for a thread
            </p>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Thread ID</label>
                <Input
                  value={threadId}
                  onChange={(e) => setThreadId(e.target.value)}
                  placeholder="Enter thread ID"
                  className="mb-2"
                />
              </div>

              <Button
                onClick={fetchFormattedMessages}
                disabled={loading}
                className="w-full"
              >
                {loading ? 'Loading...' : 'Fetch Messages'}
              </Button>
            </div>
          </Card>

          {/* Display fetched messages */}
          {messages.length > 0 && (
            <div className="mt-4">
              <h3 className="text-lg font-semibold mb-2">
                Fetched Messages ({messages.length})
              </h3>
              <div className="max-h-[600px] overflow-y-auto">
                {messages.map((msg, idx) => renderMessage(msg, idx))}
              </div>
            </div>
          )}
        </div>

        {/* Stream Endpoint Test */}
        <div>
          <Card className="p-6">
            <h2 className="text-xl font-semibold mb-4">Test Stream Endpoint</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Stream formatted messages for an agent run
            </p>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Agent Run ID</label>
                <Input
                  value={agentRunId}
                  onChange={(e) => setAgentRunId(e.target.value)}
                  placeholder="Enter agent run ID"
                  className="mb-2"
                />
              </div>

              <Button
                onClick={startFormattedStream}
                disabled={streaming}
                className="w-full"
              >
                {streaming ? 'Streaming...' : 'Start Stream'}
              </Button>

              {streaming && (
                <div className="text-sm text-muted-foreground flex items-center gap-2">
                  <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                  Stream is active...
                </div>
              )}
            </div>
          </Card>

          {/* Display streaming messages */}
          {streamingMessages.length > 0 && (
            <div className="mt-4">
              <h3 className="text-lg font-semibold mb-2">
                Streaming Messages ({streamingMessages.length})
              </h3>
              <div className="max-h-[600px] overflow-y-auto">
                {streamingMessages.map((msg, idx) => renderMessage(msg, idx))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Instructions */}
      <Card className="p-6 mt-8">
        <h3 className="text-lg font-semibold mb-4">How to Use</h3>
        <div className="space-y-4 text-sm">
          <div>
            <h4 className="font-semibold mb-1">GET Endpoint:</h4>
            <p className="text-muted-foreground">
              Enter a thread ID and click "Fetch Messages" to retrieve all formatted messages
              for that thread. Messages are parsed with XML tool calls extracted and text
              cleaned.
            </p>
          </div>

          <div>
            <h4 className="font-semibold mb-1">Stream Endpoint:</h4>
            <p className="text-muted-foreground">
              Enter an agent run ID and click "Start Stream" to watch messages arrive in
              real-time. Streaming chunks will be combined automatically.
            </p>
          </div>

          <div>
            <h4 className="font-semibold mb-1">Message Types:</h4>
            <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
              <li><span className="font-mono">user</span> - User messages with text and attachments</li>
              <li><span className="font-mono">assistant_text</span> - Assistant responses (XML stripped)</li>
              <li><span className="font-mono">tool_call</span> - Tool invocations with parameters</li>
              <li><span className="font-mono">tool_result</span> - Tool execution results</li>
              <li><span className="font-mono">status</span> - System status messages</li>
              <li><span className="font-mono">system</span> - System messages</li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold mb-1">API Endpoints:</h4>
            <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2 font-mono text-xs">
              <li>GET /api/threads/:threadId/messages/formatted</li>
              <li>GET /api/agent-run/:agentRunId/stream/formatted</li>
            </ul>
          </div>
        </div>
      </Card>

      {/* Raw JSON Display */}
      {(messages.length > 0 || streamingMessages.length > 0) && (
        <Card className="p-6 mt-4">
          <h3 className="text-lg font-semibold mb-4">Raw JSON Output</h3>
          <pre className="text-xs bg-black/5 dark:bg-white/5 p-4 rounded overflow-x-auto max-h-96 overflow-y-auto">
            {JSON.stringify(
              {
                fetched: messages.slice(0, 3),
                streaming: streamingMessages.slice(0, 3),
              },
              null,
              2
            )}
          </pre>
          <p className="text-xs text-muted-foreground mt-2">
            Showing first 3 messages from each section. Check browser console for full output.
          </p>
        </Card>
      )}
    </div>
  );
}

