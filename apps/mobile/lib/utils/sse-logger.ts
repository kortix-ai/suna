/**
 * SSE Logger - Logs all text chunks received from backend via SSE
 * 
 * This utility creates a log file that captures all text chunks received
 * from the backend during agent streaming. The log file can be viewed
 * to debug streaming issues.
 * 
 * How to view logs:
 * 1. iOS Simulator: 
 *    - Open Finder
 *    - Press Cmd+Shift+G
 *    - Navigate to: ~/Library/Developer/CoreSimulator/Devices/[DEVICE_ID]/data/Containers/Data/Application/[APP_ID]/Library/Caches/
 *    - Look for file: sse-text-chunks-[TIMESTAMP].log
 * 
 * 2. iOS Device (via Xcode):
 *    - Connect device
 *    - Open Xcode > Window > Devices and Simulators
 *    - Select your device
 *    - Select your app
 *    - Click "Download Container"
 *    - Navigate to Library/Caches/ in the downloaded container
 *    - Find: sse-text-chunks-[TIMESTAMP].log
 * 
 * 3. Android Emulator:
 *    - Use adb: adb shell
 *    - Navigate to: /data/data/[PACKAGE_NAME]/cache/
 *    - Find: sse-text-chunks-[TIMESTAMP].log
 *    - Pull file: adb pull /data/data/[PACKAGE_NAME]/cache/sse-text-chunks-[TIMESTAMP].log
 * 
 * 4. Android Device:
 *    - Enable USB debugging
 *    - Use adb pull as above
 * 
 * 5. View in app console:
 *    - All logs are also printed to console with [SSE-LOG] prefix
 *    - Use React Native Debugger or Metro bundler console
 */

import * as FileSystem from 'expo-file-system/legacy';

interface SSELogEntry {
  timestamp: string;
  runId: string;
  threadId: string;
  sequence: number | undefined;
  content: string;
  contentLength: number;
  messageType: string;
  rawMessage?: any;
}

class SSELogger {
  private logFilePath: string | null = null;
  private logBuffer: string[] = [];
  private bufferFlushInterval: ReturnType<typeof setInterval> | null = null;
  private isInitialized = false;
  private maxLogSize = 10 * 1024 * 1024; // 10MB max log size
  private currentLogSize = 0;
  private currentRunId: string | null = null;
  private currentThreadId: string | null = null;

  async initialize(runId: string, threadId: string): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.currentRunId = runId;
      this.currentThreadId = threadId;
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `sse-text-chunks-${timestamp}.log`;
      this.logFilePath = `${FileSystem.cacheDirectory}${fileName}`;

      // Initialize log file with header
      const header = `========================================
SSE Text Chunks Log
========================================
Started: ${new Date().toISOString()}
Run ID: ${runId}
Thread ID: ${threadId}
Log File: ${this.logFilePath}
========================================

`;
      
      await FileSystem.writeAsStringAsync(this.logFilePath, header);
      this.currentLogSize = header.length;
      this.isInitialized = true;

      // Start buffer flush interval (flush every 2 seconds)
      this.bufferFlushInterval = setInterval(() => {
        this.flushBuffer();
      }, 2000);

      console.log(`[SSE-LOG] ✅ Logging initialized: ${this.logFilePath}`);
    } catch (error) {
      console.error('[SSE-LOG] ❌ Failed to initialize logging:', error);
    }
  }

  async logTextChunk(entry: SSELogEntry): Promise<void> {
    if (!this.isInitialized || !this.logFilePath) {
      return;
    }

    try {
      // Format log entry
      const logEntry = `[${entry.timestamp}] [SEQ: ${entry.sequence ?? 'N/A'}] [LEN: ${entry.contentLength}]
Run ID: ${entry.runId}
Thread ID: ${entry.threadId}
Type: ${entry.messageType}
Content: ${entry.content}
${entry.rawMessage ? `Raw Message: ${JSON.stringify(entry.rawMessage, null, 2)}` : ''}
${'─'.repeat(80)}

`;

      // Add to buffer
      this.logBuffer.push(logEntry);
      this.currentLogSize += logEntry.length;

      // Also log to console for immediate visibility
      console.log(`[SSE-LOG] 📝 Text Chunk [SEQ: ${entry.sequence ?? 'N/A'}] [LEN: ${entry.contentLength}]:`, entry.content);

      // Flush if buffer is getting large (> 50KB)
      if (this.logBuffer.join('').length > 50 * 1024) {
        await this.flushBuffer();
      }

      // Rotate log if it gets too large
      if (this.currentLogSize > this.maxLogSize) {
        await this.rotateLog();
      }
    } catch (error) {
      console.error('[SSE-LOG] ❌ Failed to log text chunk:', error);
    }
  }

  async logRawMessage(rawData: string, runId: string, threadId: string): Promise<void> {
    if (!this.isInitialized || !this.logFilePath) {
      return;
    }

    try {
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] RAW SSE MESSAGE
Run ID: ${runId}
Thread ID: ${threadId}
Raw Data: ${rawData}
${'─'.repeat(80)}

`;

      this.logBuffer.push(logEntry);
      this.currentLogSize += logEntry.length;

      // Flush if buffer is getting large
      if (this.logBuffer.join('').length > 50 * 1024) {
        await this.flushBuffer();
      }
    } catch (error) {
      console.error('[SSE-LOG] ❌ Failed to log raw message:', error);
    }
  }

  private async flushBuffer(): Promise<void> {
    if (this.logBuffer.length === 0 || !this.logFilePath) {
      return;
    }

    try {
      const content = this.logBuffer.join('');
      this.logBuffer = [];

      // Append to file
      const existingContent = await FileSystem.readAsStringAsync(this.logFilePath);
      await FileSystem.writeAsStringAsync(this.logFilePath, existingContent + content);
    } catch (error) {
      console.error('[SSE-LOG] ❌ Failed to flush buffer:', error);
    }
  }

  private async rotateLog(): Promise<void> {
    if (!this.logFilePath || !this.currentRunId || !this.currentThreadId) {
      return;
    }

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const oldPath = this.logFilePath;
      const newFileName = `sse-text-chunks-${timestamp}-rotated.log`;
      const newPath = `${FileSystem.cacheDirectory}${newFileName}`;

      // Flush buffer first
      await this.flushBuffer();

      // Read old log and write to new file
      const oldContent = await FileSystem.readAsStringAsync(oldPath);
      const header = `========================================
SSE Text Chunks Log (Rotated)
========================================
Rotated: ${new Date().toISOString()}
Previous log: ${oldPath}
========================================

`;
      await FileSystem.writeAsStringAsync(newPath, header + oldContent);

      // Reset current log with stored runId and threadId
      const savedRunId = this.currentRunId;
      const savedThreadId = this.currentThreadId;
      this.isInitialized = false; // Reset before re-initializing
      await this.initialize(savedRunId, savedThreadId);

      console.log(`[SSE-LOG] 🔄 Log rotated: ${newPath}`);
    } catch (error) {
      console.error('[SSE-LOG] ❌ Failed to rotate log:', error);
    }
  }

  async finalize(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      // Clear interval
      if (this.bufferFlushInterval) {
        clearInterval(this.bufferFlushInterval);
        this.bufferFlushInterval = null;
      }

      // Flush remaining buffer
      await this.flushBuffer();

      // Add footer
      if (this.logFilePath) {
        const footer = `
========================================
Log Ended: ${new Date().toISOString()}
Total Size: ${this.currentLogSize} bytes
========================================
`;
        const existingContent = await FileSystem.readAsStringAsync(this.logFilePath);
        await FileSystem.writeAsStringAsync(this.logFilePath, existingContent + footer);
      }

      console.log(`[SSE-LOG] ✅ Logging finalized: ${this.logFilePath}`);
      this.isInitialized = false;
      this.currentRunId = null;
      this.currentThreadId = null;
    } catch (error) {
      console.error('[SSE-LOG] ❌ Failed to finalize logging:', error);
    }
  }

  getLogFilePath(): string | null {
    return this.logFilePath;
  }
}

// Singleton instance
export const sseLogger = new SSELogger();

