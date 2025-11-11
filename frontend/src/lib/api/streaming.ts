// Streaming utilities for agent runs

// Set to keep track of agent runs that are known to be non-running
export const nonRunningAgentRuns = new Set<string>();
// Map to keep track of active EventSource streams
export const activeStreams = new Map<string, EventSource>();

/**
 * Helper function to safely cleanup EventSource connections
 * This ensures consistent cleanup and prevents memory leaks
 */
export const cleanupEventSource = (agentRunId: string, reason?: string): void => {
  const stream = activeStreams.get(agentRunId);
  if (stream) {
    if (reason) {
      console.log(`[STREAM] Cleaning up EventSource for ${agentRunId}: ${reason}`);
    }
    
    // Close the connection
    if (stream.readyState !== EventSource.CLOSED) {
      stream.close();
    }
    
    // Remove from active streams
    activeStreams.delete(agentRunId);
  }
};

/**
 * Failsafe cleanup function to prevent memory leaks
 * Should be called periodically or during app teardown
 */
export const cleanupAllEventSources = (reason = 'batch cleanup'): void => {
  console.log(`[STREAM] Running batch cleanup: ${activeStreams.size} active streams`);
  
  const streamIds = Array.from(activeStreams.keys());
  streamIds.forEach(agentRunId => {
    cleanupEventSource(agentRunId, reason);
  });
};

