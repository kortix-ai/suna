import type { ConnectionState } from './types';
import { STREAM_CONFIG } from './constants';
import { calculateExponentialBackoff, formatStreamUrl } from './utils';

export interface StreamConnectionOptions {
  apiUrl: string;
  runId: string;
  getAuthToken: () => Promise<string | null>;
  onMessage: (data: string) => void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  onStateChange?: (state: ConnectionState) => void;
}

type EventHandler = (...args: unknown[]) => void;

export class StreamConnection {
  private eventSource: EventSource | null = null;
  private state: ConnectionState = 'idle';
  private reconnectAttempts = 0;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;
  private isDestroyed = false;
  private options: StreamConnectionOptions;
  private eventHandlers: Map<string, EventHandler> = new Map();
  
  constructor(options: StreamConnectionOptions) {
    this.options = options;
  }
  
  async connect(): Promise<void> {
    if (this.isDestroyed) {
      return;
    }
    
    this.cleanup();
    this.setState('connecting');
    
    try {
      const token = await this.options.getAuthToken();
      const url = formatStreamUrl(this.options.apiUrl, this.options.runId, token);
      
      this.eventSource = new EventSource(url);
      this.setupEventHandlers();
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
    }
  }
  
  private setupEventHandlers(): void {
    if (!this.eventSource) return;
    
    const onOpen = () => {
      if (this.isDestroyed) return;
      
      this.reconnectAttempts = 0;
      this.lastMessageTime = Date.now();
      this.setState('connected');
      this.startHeartbeatMonitor();
      this.options.onOpen?.();
    };
    
    const onMessage = (event: MessageEvent) => {
      if (this.isDestroyed) return;
      
      this.lastMessageTime = Date.now();
      
      if (this.state === 'connected') {
        this.setState('streaming');
      }
      
      this.options.onMessage(event.data);
    };
    
    const onError = () => {
      if (this.isDestroyed) return;
      this.handleConnectionError();
    };
    
    this.eventHandlers.set('open', onOpen);
    this.eventHandlers.set('message', onMessage);
    this.eventHandlers.set('error', onError);
    
    this.eventSource.addEventListener('open', onOpen);
    this.eventSource.addEventListener('message', onMessage);
    this.eventSource.addEventListener('error', onError);
  }
  
  private handleConnectionError(): void {
    const error = new Error('EventSource connection error');
    
    if (this.shouldReconnect()) {
      this.scheduleReconnect();
    } else {
      this.handleError(error);
    }
  }
  
  private handleError(error: Error): void {
    this.setState('error');
    this.options.onError?.(error);
    this.cleanup();
  }
  
  private shouldReconnect(): boolean {
    return (
      !this.isDestroyed &&
      this.reconnectAttempts < STREAM_CONFIG.RECONNECT_MAX_ATTEMPTS &&
      this.state !== 'closed'
    );
  }
  
  private scheduleReconnect(): void {
    if (this.isDestroyed) return;
    
    this.setState('reconnecting');
    this.reconnectAttempts++;
    
    const delay = calculateExponentialBackoff(
      this.reconnectAttempts - 1,
      STREAM_CONFIG.RECONNECT_BASE_DELAY_MS,
      STREAM_CONFIG.RECONNECT_MAX_DELAY_MS,
      STREAM_CONFIG.RECONNECT_BACKOFF_MULTIPLIER
    );
    
    this.reconnectTimeoutId = setTimeout(() => {
      if (!this.isDestroyed) {
        this.connect();
      }
    }, delay);
  }
  
  private startHeartbeatMonitor(): void {
    this.stopHeartbeatMonitor();
    
    this.heartbeatIntervalId = setInterval(() => {
      if (this.isDestroyed) {
        this.stopHeartbeatMonitor();
        return;
      }
      
      const timeSinceLastMessage = Date.now() - this.lastMessageTime;
      
      if (timeSinceLastMessage > STREAM_CONFIG.HEARTBEAT_TIMEOUT_MS) {
        console.warn(`[StreamConnection] No message received for ${timeSinceLastMessage}ms`);
        this.handleConnectionError();
      }
    }, STREAM_CONFIG.HEARTBEAT_CHECK_INTERVAL_MS);
  }
  
  private stopHeartbeatMonitor(): void {
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }
  }
  
  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.options.onStateChange?.(newState);
    }
  }
  
  private cleanup(): void {
    this.stopHeartbeatMonitor();
    
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    
    if (this.eventSource) {
      this.eventHandlers.forEach((handler, event) => {
        this.eventSource?.removeEventListener(event, handler as EventListener);
      });
      this.eventHandlers.clear();
      
      try {
        this.eventSource.close();
      } catch {
      }
      this.eventSource = null;
    }
  }
  
  close(): void {
    this.setState('closed');
    this.cleanup();
    this.options.onClose?.();
  }
  
  destroy(): void {
    this.isDestroyed = true;
    this.close();
  }
  
  getState(): ConnectionState {
    return this.state;
  }
  
  isConnected(): boolean {
    return this.state === 'connected' || this.state === 'streaming';
  }
  
  isActive(): boolean {
    return !this.isDestroyed && this.state !== 'closed' && this.state !== 'error';
  }
  
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }
}

export function createStreamConnection(options: StreamConnectionOptions): StreamConnection {
  return new StreamConnection(options);
}
