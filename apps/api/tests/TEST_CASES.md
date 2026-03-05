# Agent Test Cases

Comprehensive test case list for validating agent reliability.

---

## 1. Core Agent Lifecycle

### 1.1 Basic Operations
- [ ] Start simple agent run ("Hello, what can you do?")
- [ ] Start agent run on existing thread
- [ ] Start agent run on new thread
- [ ] Verify status transitions: `queued` → `running` → `completed`
- [ ] Verify SSE stream events arrive in real-time

### 1.2 Stop/Cancel
- [ ] Stop agent run via API while running
- [ ] Stop agent run via UI during tool execution
- [ ] Stop during LLM streaming
- [ ] Verify final status is `stopped`

### 1.3 Auto-Continue
- [ ] Trigger auto-continue via tool calls
- [ ] Trigger auto-continue via length limit
- [ ] Hit max auto-continue limit (25)
- [ ] Verify `agent_terminated` stops auto-continue

---

## 2. Limits and Billing

### 2.1 Concurrent Runs
- [ ] Start run at concurrent limit
- [ ] Attempt second run → `AGENT_RUN_LIMIT_EXCEEDED`
- [ ] Complete first, verify second can start

### 2.2 Credits
- [ ] Run with sufficient credits → success
- [ ] Run with zero credits → `INSUFFICIENT_CREDITS`

### 2.3 Model Access
- [ ] Use allowed model → success
- [ ] Use disallowed model → `MODEL_ACCESS_DENIED`

---

## 3. Sandbox Tools

### 3.1 Shell (`sb_shell_tool`)
- [ ] Execute `echo "hello"`
- [ ] Execute `ls -la`
- [ ] Execute failing command (non-zero exit)
- [ ] Execute Python script
- [ ] Long-running command timeout

### 3.2 Files (`sb_files_tool`)
- [ ] Create file
- [ ] Read file
- [ ] Update file
- [ ] Delete file
- [ ] Create directory
- [ ] File not found error

### 3.3 Vision (`sb_vision_tool`)
- [ ] Analyze screenshot
- [ ] Extract text (OCR)
- [ ] Handle corrupted image

### 3.4 Expose (`sb_expose_tool`)
- [ ] Expose port 8080
- [ ] Verify URL accessible

### 3.5 Presentation (`sb_presentation_tool`)
- [ ] Generate presentation
- [ ] Export to PDF

### 3.6 Git Sync (`sb_git_sync`)
- [ ] Clone public repo
- [ ] Clone private repo
- [ ] Push changes
- [ ] Handle auth failure

### 3.7 Upload (`sb_upload_file_tool`)
- [ ] Upload small file (<1MB)
- [ ] Upload at limit (50MB)
- [ ] Exceed limit → error
- [ ] Verify signed URL returned

---

## 4. Search Tools

### 4.1 Web Search
- [ ] Single query
- [ ] Batch queries (array)
- [ ] With date filter
- [ ] Handle timeout

### 4.2 Image/People/Company/Paper Search
- [ ] Basic search
- [ ] Handle no results

---

## 5. Browser Tool

### 5.1 Navigation
- [ ] Navigate to URL
- [ ] Handle invalid URL
- [ ] Handle timeout

### 5.2 Actions
- [ ] Click button
- [ ] Fill form
- [ ] Select dropdown
- [ ] Scroll page
- [ ] Element not found error

### 5.3 Extraction
- [ ] Extract text
- [ ] Extract structured data
- [ ] Take screenshot

---

## 6. Agent Builder Tools

### 6.1 Configuration
- [ ] Get current config
- [ ] Update name/description
- [ ] Enable/disable tools

### 6.2 MCP Integration
- [ ] Search MCP servers
- [ ] Test connection
- [ ] Handle connection failure

### 6.3 Credential Profiles
- [ ] Create profile
- [ ] Configure for agent
- [ ] Handle invalid profile

### 6.4 Triggers
- [ ] Create scheduled trigger
- [ ] Toggle on/off
- [ ] Delete trigger

---

## 7. Knowledge Base

- [ ] Semantic search in workspace
- [ ] Sync global KB
- [ ] Upload to global KB
- [ ] Verify 50MB limit

---

## 8. Error Handling

### 8.1 LLM Errors
- [ ] Handle timeout
- [ ] Handle rate limit
- [ ] Handle API error (500)
- [ ] Verify retry (1 retry)

### 8.2 Sandbox Errors
- [ ] Handle not found
- [ ] Handle 502/503/504 (retry)
- [ ] Handle starting state

### 8.3 Database Errors
- [ ] Handle connection timeout
- [ ] Verify retry with reconnect

### 8.4 Tool Errors
- [ ] Handle execution failure
- [ ] Verify agent recovers

---

## 9. Streaming

- [ ] Stream connects successfully
- [ ] Chunks arrive in order
- [ ] Reconnection on disconnect
- [ ] Catch-up missed messages
- [ ] Verify all event types: `content`, `tool_call`, `tool_result`, `status`

---

## 10. Concurrency

### 10.1 Slot Manager
- [ ] Reserve slot
- [ ] Release on completion
- [ ] Release on error
- [ ] Rapid start/stop cycles

### 10.2 Webhooks
- [ ] Process once
- [ ] Reject duplicate
- [ ] Handle race condition

---

## 11. Graceful Shutdown

- [ ] Active runs stopped
- [ ] Status updated to `stopped`
- [ ] Redis stop signals set

---

## 12. Edge Cases

### 12.1 Input
- [ ] Empty prompt
- [ ] Very long prompt (>100k tokens)
- [ ] Special characters
- [ ] Non-English language

### 12.2 Output
- [ ] Very long response (length limit)
- [ ] Response with code blocks

### 12.3 State
- [ ] No tools enabled
- [ ] All tools enabled
- [ ] Invalid model name
- [ ] Deleted project/thread

---

## 13. Security

- [ ] User can only access own runs
- [ ] Admin endpoints require admin role
- [ ] SQL injection prevented
- [ ] Path traversal prevented

---

## 14. Performance

- [ ] TTFT < 3s
- [ ] Prep stages < 100ms
- [ ] 10 concurrent runs
- [ ] 50 concurrent runs
- [ ] No memory leaks

---

## Test Priority

1. **Critical**: Core Lifecycle, Limits, Error Handling
2. **High**: Sandbox Tools, Browser, Streaming
3. **Medium**: Search, Agent Builder, KB
4. **Low**: Edge Cases, Performance

## Monitoring

Watch logs for these prefixes:
- `[SLOT]` - Concurrent run management
- `[LLM]` - LLM calls and timing
- `[REDIS]` - Redis operations
- `[SANDBOX]` - Sandbox lifecycle
