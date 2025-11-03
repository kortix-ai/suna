'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { createClient } from '@/lib/supabase/client';

// TypeScript interfaces for sanitized message format
interface SanitizedMessage {
  message_id: string | null;
  type: 'user' | 'assistant' | 'tool';
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
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error('Not authenticated. Please sign in.');
      }

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/threads/${threadId}/messages/formatted`,
        {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
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
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error('Not authenticated. Please sign in.');
      }

      const url = `${process.env.NEXT_PUBLIC_BACKEND_URL}/agent-run/${agentRunId}/stream/formatted?token=${session.access_token}`;

      const eventSource = new EventSource(url);

      eventSource.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log('[SANITIZED API] Received streaming message:', message);
          
          // Only add user/assistant/tool messages (backend filters, but SSE might send completion events)
          if (message.type === 'user' || message.type === 'assistant' || message.type === 'tool') {
            setStreamingMessages((prev) => [...prev, message as SanitizedMessage]);
          }
          
          // Stream can send completion signal (not a message type we care about)
          if (message.type === 'status' || message.type === 'complete') {
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

  return (
    <div className="container mx-auto p-8 max-w-6xl">
      <h1 className="text-3xl font-bold mb-2">Sanitized API Test Page</h1>
      <p className="text-muted-foreground mb-8">
        Test the new formatted message endpoints (only returns user, assistant, tool)
      </p>

      {error && (
        <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        {/* GET Endpoint Test */}
        <Card className="p-6">
          <h2 className="text-xl font-semibold mb-4">Test GET Endpoint</h2>
          <p className="text-sm text-muted-foreground mb-4">
            GET /api/threads/:threadId/messages/formatted
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

            {messages.length > 0 && (
              <div className="text-sm text-muted-foreground">
                Returned {messages.length} messages
              </div>
            )}
          </div>
        </Card>

        {/* Stream Endpoint Test */}
        <Card className="p-6">
          <h2 className="text-xl font-semibold mb-4">Test Stream Endpoint</h2>
          <p className="text-sm text-muted-foreground mb-4">
            GET /api/agent-run/:agentRunId/stream/formatted
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
                Stream is active... ({streamingMessages.length} messages)
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* GET Messages JSON */}
      {messages.length > 0 && (
        <Card className="p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">GET Response ({messages.length} messages)</h3>
            <Button
              onClick={() => setMessages([])}
              variant="outline"
              size="sm"
            >
              Clear
            </Button>
          </div>
          <pre className="text-xs bg-black/5 dark:bg-white/5 p-4 rounded overflow-x-auto max-h-[600px] overflow-y-auto">
            {JSON.stringify(messages, null, 2)}
          </pre>
        </Card>
      )}

      {/* Stream Messages JSON */}
      {streamingMessages.length > 0 && (
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Stream Response ({streamingMessages.length} messages)</h3>
            <Button
              onClick={() => setStreamingMessages([])}
              variant="outline"
              size="sm"
            >
              Clear
            </Button>
          </div>
          <pre className="text-xs bg-black/5 dark:bg-white/5 p-4 rounded overflow-x-auto max-h-[600px] overflow-y-auto">
            {JSON.stringify(streamingMessages, null, 2)}
          </pre>
        </Card>
      )}

      {/* Info */}
      <Card className="p-6 mt-8">
        <h3 className="text-lg font-semibold mb-4">Message Types</h3>
        <div className="space-y-2 text-sm">
          <div>
            <span className="font-mono font-semibold">user</span> - User messages with text and attachments
          </div>
          <div>
            <span className="font-mono font-semibold">assistant</span> - Assistant responses with text and tool_calls array
          </div>
          <div>
            <span className="font-mono font-semibold">tool</span> - Tool execution results with name, result, success
          </div>
          <div className="text-muted-foreground mt-4">
            All other message types (status, llm_response_end, etc.) are filtered out by the backend.
          </div>
        </div>
      </Card>
    </div>
  );
}
