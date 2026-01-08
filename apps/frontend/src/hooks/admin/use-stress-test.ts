import { useState, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export interface StressTestConfig {
  num_requests: number;
  prompts?: string[];
  measure_ttft?: boolean;
  ttft_timeout?: number;
}

export interface StressTestResult {
  request_id: number;
  status: 'pending' | 'running' | 'done' | 'error';
  thread_id?: string;
  project_id?: string;
  agent_run_id?: string;
  // Timing metrics
  request_time: number;  // Time for HTTP request to complete
  time_to_first_response?: number | null;  // Time from agent start to first LLM response
  total_ttft?: number | null;  // request_time + time_to_first_response
  llm_ttft?: number | null;  // Actual LLM TTFT
  error?: string;
  // Detailed timing breakdown
  timing_breakdown?: {
    load_config_ms?: number;
    get_model_ms?: number;
    create_project_ms?: number;
    create_thread_ms?: number;
    create_message_and_run_ms?: number;
    total_setup_ms?: number;
  };
}

export interface TimingBreakdownStats {
  min: number;
  avg: number;
  max: number;
  count: number;
}

export interface StressTestSummary {
  total_requests: number;
  successful: number;
  failed: number;
  total_time: number;
  throughput: number;
  // Request times (HTTP call duration)
  min_request_time: number;
  avg_request_time: number;
  max_request_time: number;
  // Time to first response
  first_response_measured: number;
  min_time_to_first_response: number | null;
  avg_time_to_first_response: number | null;
  max_time_to_first_response: number | null;
  // Total TTFT
  min_total_ttft: number | null;
  avg_total_ttft: number | null;
  max_total_ttft: number | null;
  // Actual LLM TTFT
  llm_ttft_measured: number;
  min_llm_ttft: number | null;
  avg_llm_ttft: number | null;
  max_llm_ttft: number | null;
  error_breakdown: Record<string, number>;
  // Timing breakdown aggregates
  timing_breakdown?: {
    load_config_ms?: TimingBreakdownStats;
    get_model_ms?: TimingBreakdownStats;
    create_project_ms?: TimingBreakdownStats;
    create_thread_ms?: TimingBreakdownStats;
    create_message_and_run_ms?: TimingBreakdownStats;
    total_setup_ms?: TimingBreakdownStats;
  };
}

export interface StressTestState {
  isRunning: boolean;
  results: StressTestResult[];
  summary: StressTestSummary | null;
  currentBatch: number;
  totalBatches: number;
  error: string | null;
}

export function useStressTest() {
  const [state, setState] = useState<StressTestState>({
    isRunning: false,
    results: [],
    summary: null,
    currentBatch: 0,
    totalBatches: 0,
    error: null,
  });
  
  const abortControllerRef = useRef<AbortController | null>(null);

  const runStressTest = useCallback(async (config: StressTestConfig) => {
    // Reset state
    setState({
      isRunning: true,
      results: Array.from({ length: config.num_requests }, (_, i) => ({
        request_id: i,
        status: 'pending',
        request_time: 0,
        time_to_first_response: null,
        total_ttft: null,
      })),
      summary: null,
      currentBatch: 0,
      totalBatches: 0,  // Will be set by server response
      error: null,
    });

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error('Not authenticated');
      }

      abortControllerRef.current = new AbortController();

      const response = await fetch(`${API_URL}/admin/stress-test/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          ...config,
          measure_ttft: true,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const event = JSON.parse(line);
            
            switch (event.type) {
              case 'config':
                setState(prev => ({
                  ...prev,
                  totalBatches: event.num_batches,
                }));
                break;
                
              case 'batch_start':
                setState(prev => ({
                  ...prev,
                  currentBatch: event.batch_num,
                }));
                break;
                
              case 'status':
                setState(prev => ({
                  ...prev,
                  results: prev.results.map(r =>
                    r.request_id === event.request_id
                      ? { ...r, status: event.status }
                      : r
                  ),
                }));
                break;
                
              case 'result':
                setState(prev => ({
                  ...prev,
                  results: prev.results.map(r =>
                    r.request_id === event.request_id
                      ? {
                          request_id: event.request_id,
                          status: event.status,
                          thread_id: event.thread_id,
                          project_id: event.project_id,
                          agent_run_id: event.agent_run_id,
                          request_time: event.request_time,
                          time_to_first_response: event.time_to_first_response,
                          total_ttft: event.total_ttft,
                          llm_ttft: event.llm_ttft,
                          error: event.error,
                          timing_breakdown: event.timing_breakdown,
                        }
                      : r
                  ),
                }));
                break;
                
              case 'summary':
                setState(prev => ({
                  ...prev,
                  isRunning: false,
                  summary: {
                    total_requests: event.total_requests,
                    successful: event.successful,
                    failed: event.failed,
                    total_time: event.total_time,
                    throughput: event.throughput,
                    min_request_time: event.min_request_time,
                    avg_request_time: event.avg_request_time,
                    max_request_time: event.max_request_time,
                    first_response_measured: event.first_response_measured,
                    min_time_to_first_response: event.min_time_to_first_response,
                    avg_time_to_first_response: event.avg_time_to_first_response,
                    max_time_to_first_response: event.max_time_to_first_response,
                    min_total_ttft: event.min_total_ttft,
                    avg_total_ttft: event.avg_total_ttft,
                    max_total_ttft: event.max_total_ttft,
                    llm_ttft_measured: event.llm_ttft_measured ?? 0,
                    min_llm_ttft: event.min_llm_ttft,
                    avg_llm_ttft: event.avg_llm_ttft,
                    max_llm_ttft: event.max_llm_ttft,
                    error_breakdown: event.error_breakdown,
                    timing_breakdown: event.timing_breakdown,
                  },
                }));
                break;
            }
          } catch (parseError) {
            console.error('Failed to parse event:', line, parseError);
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setState(prev => ({
          ...prev,
          isRunning: false,
          error: 'Test cancelled',
        }));
      } else {
        setState(prev => ({
          ...prev,
          isRunning: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }));
      }
    }
  }, []);

  const cancelTest = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  const resetTest = useCallback(() => {
    setState({
      isRunning: false,
      results: [],
      summary: null,
      currentBatch: 0,
      totalBatches: 0,
      error: null,
    });
  }, []);

  return {
    state,
    runStressTest,
    cancelTest,
    resetTest,
  };
}
