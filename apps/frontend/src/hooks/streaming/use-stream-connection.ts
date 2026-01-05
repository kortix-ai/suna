import { useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

const SESSION_STORAGE_KEY = "agent-stream-sessions";

function getSessionId(agentRunId: string): string {
  if (typeof window === "undefined") return "";
  
  try {
    const sessions = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "{}");
    if (!sessions[agentRunId]) {
      sessions[agentRunId] = crypto.randomUUID().slice(0, 8);
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
    }
    return sessions[agentRunId];
  } catch {
    return crypto.randomUUID().slice(0, 8);
  }
}

async function getAccessToken(): Promise<string> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  
  if (!session?.access_token) {
    throw new Error("No access token available");
  }
  
  return session.access_token;
}

export interface UseStreamConnectionResult {
  state: "idle" | "connecting" | "connected" | "error";
  connect: (agentRunId: string) => Promise<void>;
  disconnect: () => void;
}

export function useStreamConnection(
  onMessage: (data: string) => void,
  onError: (error: Error) => void,
  onClose: () => void,
): UseStreamConnectionResult {
  const eventSourceRef = useRef<EventSource | null>(null);
  const [state, setState] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  
  const connect = useCallback(async (agentRunId: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    
    setState("connecting");
    
    try {
      const sessionId = getSessionId(agentRunId);
      const token = await getAccessToken();
      
      const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "";
      const url = new URL(`${API_URL}/v1/streaming/${agentRunId}`);
      url.searchParams.set("session_id", sessionId);
      url.searchParams.set("token", token);
      
      const es = new EventSource(url.toString());
      eventSourceRef.current = es;
      
      es.onopen = () => {
        setState("connected");
      };
      
      es.onmessage = (event) => {
        if (event.data) {
          if (event.data.startsWith("data: ")) {
            onMessage(event.data);
          } else {
            onMessage(`data: ${event.data}`);
          }
        }
      };
      
      es.onerror = () => {
        setState("error");
        onError(new Error("Stream connection failed"));
      };
    } catch (error) {
      setState("error");
      onError(error instanceof Error ? error : new Error("Failed to connect to stream"));
    }
  }, [onMessage, onError]);
  
  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setState("idle");
    onClose();
  }, [onClose]);
  
  return { state, connect, disconnect };
}
