# File Upload Implementation Guide

## Overview

The unified `/agent/start` endpoint now supports file uploads for **BOTH** new and existing threads with robust sandbox handling.

## How It Works

### 🆕 New Thread + Files

**Flow:**
1. User sends `POST /agent/start` with `prompt` and `files` (no `thread_id`)
2. Backend creates project
3. Backend creates sandbox (because files are present)
4. Backend uploads files to sandbox
5. Backend creates thread
6. Backend creates user message with file references
7. Backend starts agent run

**Example Request:**
```typescript
const formData = new FormData();
formData.append('prompt', 'Analyze this document');
formData.append('files', documentFile);
formData.append('agent_id', 'agent-123');

await unifiedAgentStart({
  prompt: 'Analyze this document',
  files: [documentFile],
  agent_id: 'agent-123'
});
```

### ♻️ Existing Thread + Files

**Flow:**
1. User sends `POST /agent/start` with `thread_id` and `files`
2. Backend validates thread exists
3. Backend retrieves existing sandbox OR creates new sandbox if none exists
4. Backend uploads files to sandbox
5. Backend creates user message with file references (if prompt provided)
6. Backend starts agent run

**Example Request:**
```typescript
await unifiedAgentStart({
  threadId: 'thread-456',
  prompt: 'Here are more files to analyze',
  files: [image1, image2],
  agent_id: 'agent-123'
});
```

## Key Features

### ✅ Automatic Sandbox Management

**For New Threads:**
- Sandbox created automatically when files are provided
- No sandbox created if no files (lazy creation by tools)

**For Existing Threads:**
- Retrieves existing sandbox if it exists
- Creates new sandbox if files provided but no sandbox exists
- Uses `get_or_start_sandbox()` to ensure sandbox is running

### ✅ Robust File Handling

**File Upload Process:**
1. Sanitize filename (replace `/` and `\`)
2. Generate unique filename to avoid conflicts
3. Upload to sandbox `/workspace/uploads/` directory
4. Verify file was uploaded successfully
5. Add file reference to message content

**Error Handling:**
- Track successful and failed uploads separately
- Include successful files in message
- List failed files in message
- Clean up on errors (delete project/sandbox if creation fails)

### ✅ Message Content Format

**With Files:**
```
User's prompt text

[Uploaded File: /workspace/uploads/document.pdf]
[Uploaded File: /workspace/uploads/image.png]

The following files failed to upload:
- corrupted_file.doc
```

**Without Files:**
```
User's prompt text
```

## Implementation Details

### Helper Functions

#### `_ensure_sandbox_for_thread(client, project_id, files)`
```python
# Returns: (sandbox_object, sandbox_id) or (None, None)

# Case 1: Sandbox exists
- Retrieves existing sandbox using get_or_start_sandbox()
- Returns sandbox object for file uploads

# Case 2: No sandbox, files provided
- Creates new sandbox
- Updates project with sandbox metadata
- Returns new sandbox object

# Case 3: No sandbox, no files
- Returns (None, None)
- Sandbox will be created lazily by tools if needed
```

#### `_handle_file_uploads(files, sandbox, project_id, prompt)`
```python
# Returns: message_content with file references

# Process:
1. For each file:
   - Sanitize filename
   - Generate unique name
   - Upload to /workspace/uploads/
   - Verify upload
   - Track success/failure

2. Build message content:
   - Start with prompt
   - Add successful file references
   - List failed uploads (if any)

3. Return complete message content
```

## API Contract

### Request Format (FormData)

```typescript
POST /agent/start

FormData fields:
- thread_id?: string          // Optional - omit for new thread
- prompt?: string             // Required for new thread, optional for existing
- files?: File[]              // Multiple files supported
- model_name?: string         // Optional model selection
- agent_id?: string           // Optional agent selection
```

### Response Format

```json
{
  "thread_id": "uuid-here",
  "agent_run_id": "uuid-here",
  "status": "running"
}
```

## Client Usage

### Frontend (TypeScript)

```typescript
// New thread with files
await unifiedAgentStart({
  prompt: 'Analyze these documents',
  files: [file1, file2, file3],
  model_name: 'claude-sonnet-4',
  agent_id: 'my-agent-id'
});

// Existing thread with files
await unifiedAgentStart({
  threadId: 'existing-thread-id',
  prompt: 'Here are more files',
  files: [newFile],
});

// Existing thread, just start agent (no files)
await unifiedAgentStart({
  threadId: 'existing-thread-id',
});
```

### Mobile (React Native)

```typescript
const mutation = useUnifiedAgentStart();

// New thread with files
await mutation.mutateAsync({
  prompt: 'Check this image',
  files: [imageFile],
  modelName: 'claude-sonnet-4',
  agentId: 'my-agent-id'
});

// Existing thread with files
await mutation.mutateAsync({
  threadId: 'existing-thread-id',
  prompt: 'More context',
  files: [documentFile],
});
```

## Testing Scenarios

### ✅ Test Case 1: New Thread + Single File
```typescript
await unifiedAgentStart({
  prompt: 'Analyze this PDF',
  files: [pdfFile]
});
```
**Expected:**
- ✅ Project created
- ✅ Sandbox created
- ✅ File uploaded to sandbox
- ✅ Thread created
- ✅ Message includes file reference
- ✅ Agent run started

### ✅ Test Case 2: New Thread + Multiple Files
```typescript
await unifiedAgentStart({
  prompt: 'Process these images',
  files: [img1, img2, img3]
});
```
**Expected:**
- ✅ All files uploaded
- ✅ Message includes all file references
- ✅ Each file has unique name

### ✅ Test Case 3: Existing Thread + Files (No Sandbox Yet)
```typescript
await unifiedAgentStart({
  threadId: 'thread-with-no-sandbox',
  prompt: 'Here is a file',
  files: [newFile]
});
```
**Expected:**
- ✅ Sandbox created for existing thread
- ✅ File uploaded
- ✅ Message created with file reference

### ✅ Test Case 4: Existing Thread + Files (Sandbox Exists)
```typescript
await unifiedAgentStart({
  threadId: 'thread-with-existing-sandbox',
  prompt: 'More files',
  files: [additionalFile]
});
```
**Expected:**
- ✅ Existing sandbox retrieved
- ✅ File uploaded to existing sandbox
- ✅ Message created with file reference

### ✅ Test Case 5: Existing Thread + No Files
```typescript
await unifiedAgentStart({
  threadId: 'existing-thread',
  prompt: 'Continue conversation'
});
```
**Expected:**
- ✅ No sandbox operations
- ✅ Message created with prompt
- ✅ Agent run started

### ✅ Test Case 6: Existing Thread + Just Start (No Prompt, No Files)
```typescript
await unifiedAgentStart({
  threadId: 'existing-thread'
});
```
**Expected:**
- ✅ No message created
- ✅ Agent run started directly

## Error Handling

### File Upload Errors
- Individual file failures are tracked
- Successful uploads still proceed
- Failed files listed in message
- Full sandbox creation failure → HTTP 500

### Sandbox Errors
- Can't retrieve existing sandbox → HTTP 500
- Can't create new sandbox → HTTP 500
- Project cleanup on failure

### Validation Errors
- No prompt for new thread → HTTP 400
- Thread not found → HTTP 404
- No authentication → HTTP 401
- Billing issues → HTTP 402
- Rate limits → HTTP 429

## Performance Considerations

### File Upload
- Files uploaded sequentially (not parallel)
- 200ms delay for verification after each upload
- Verification checks sandbox filesystem

### Sandbox Operations
- Retrieval: ~100-500ms (if already running)
- Creation: ~5-10s (first time)
- Starting stopped sandbox: ~3-5s

## Security

### File Sanitization
- Filenames sanitized (remove `/` and `\`)
- Unique filenames generated to prevent conflicts
- Files uploaded to isolated `/workspace/uploads/` directory

### Access Control
- Thread ownership verified
- User authorization checked
- Sandbox isolated per project

## Limitations

### File Size
- Controlled by FastAPI/Nginx limits
- Default: Depends on server configuration

### File Types
- All file types supported
- No MIME type restrictions at upload level
- Agent decides how to handle different types

### Concurrent Uploads
- Sequential upload (one at a time)
- Future: Could be parallelized for better performance

---

**Status:** ✅ FULLY IMPLEMENTED  
**Date:** 2025-10-25  
**File Upload:** Works for both new and existing threads with automatic sandbox management


## Overview

The unified `/agent/start` endpoint now supports file uploads for **BOTH** new and existing threads with robust sandbox handling.

## How It Works

### 🆕 New Thread + Files

**Flow:**
1. User sends `POST /agent/start` with `prompt` and `files` (no `thread_id`)
2. Backend creates project
3. Backend creates sandbox (because files are present)
4. Backend uploads files to sandbox
5. Backend creates thread
6. Backend creates user message with file references
7. Backend starts agent run

**Example Request:**
```typescript
const formData = new FormData();
formData.append('prompt', 'Analyze this document');
formData.append('files', documentFile);
formData.append('agent_id', 'agent-123');

await unifiedAgentStart({
  prompt: 'Analyze this document',
  files: [documentFile],
  agent_id: 'agent-123'
});
```

### ♻️ Existing Thread + Files

**Flow:**
1. User sends `POST /agent/start` with `thread_id` and `files`
2. Backend validates thread exists
3. Backend retrieves existing sandbox OR creates new sandbox if none exists
4. Backend uploads files to sandbox
5. Backend creates user message with file references (if prompt provided)
6. Backend starts agent run

**Example Request:**
```typescript
await unifiedAgentStart({
  threadId: 'thread-456',
  prompt: 'Here are more files to analyze',
  files: [image1, image2],
  agent_id: 'agent-123'
});
```

## Key Features

### ✅ Automatic Sandbox Management

**For New Threads:**
- Sandbox created automatically when files are provided
- No sandbox created if no files (lazy creation by tools)

**For Existing Threads:**
- Retrieves existing sandbox if it exists
- Creates new sandbox if files provided but no sandbox exists
- Uses `get_or_start_sandbox()` to ensure sandbox is running

### ✅ Robust File Handling

**File Upload Process:**
1. Sanitize filename (replace `/` and `\`)
2. Generate unique filename to avoid conflicts
3. Upload to sandbox `/workspace/uploads/` directory
4. Verify file was uploaded successfully
5. Add file reference to message content

**Error Handling:**
- Track successful and failed uploads separately
- Include successful files in message
- List failed files in message
- Clean up on errors (delete project/sandbox if creation fails)

### ✅ Message Content Format

**With Files:**
```
User's prompt text

[Uploaded File: /workspace/uploads/document.pdf]
[Uploaded File: /workspace/uploads/image.png]

The following files failed to upload:
- corrupted_file.doc
```

**Without Files:**
```
User's prompt text
```

## Implementation Details

### Helper Functions

#### `_ensure_sandbox_for_thread(client, project_id, files)`
```python
# Returns: (sandbox_object, sandbox_id) or (None, None)

# Case 1: Sandbox exists
- Retrieves existing sandbox using get_or_start_sandbox()
- Returns sandbox object for file uploads

# Case 2: No sandbox, files provided
- Creates new sandbox
- Updates project with sandbox metadata
- Returns new sandbox object

# Case 3: No sandbox, no files
- Returns (None, None)
- Sandbox will be created lazily by tools if needed
```

#### `_handle_file_uploads(files, sandbox, project_id, prompt)`
```python
# Returns: message_content with file references

# Process:
1. For each file:
   - Sanitize filename
   - Generate unique name
   - Upload to /workspace/uploads/
   - Verify upload
   - Track success/failure

2. Build message content:
   - Start with prompt
   - Add successful file references
   - List failed uploads (if any)

3. Return complete message content
```

## API Contract

### Request Format (FormData)

```typescript
POST /agent/start

FormData fields:
- thread_id?: string          // Optional - omit for new thread
- prompt?: string             // Required for new thread, optional for existing
- files?: File[]              // Multiple files supported
- model_name?: string         // Optional model selection
- agent_id?: string           // Optional agent selection
```

### Response Format

```json
{
  "thread_id": "uuid-here",
  "agent_run_id": "uuid-here",
  "status": "running"
}
```

## Client Usage

### Frontend (TypeScript)

```typescript
// New thread with files
await unifiedAgentStart({
  prompt: 'Analyze these documents',
  files: [file1, file2, file3],
  model_name: 'claude-sonnet-4',
  agent_id: 'my-agent-id'
});

// Existing thread with files
await unifiedAgentStart({
  threadId: 'existing-thread-id',
  prompt: 'Here are more files',
  files: [newFile],
});

// Existing thread, just start agent (no files)
await unifiedAgentStart({
  threadId: 'existing-thread-id',
});
```

### Mobile (React Native)

```typescript
const mutation = useUnifiedAgentStart();

// New thread with files
await mutation.mutateAsync({
  prompt: 'Check this image',
  files: [imageFile],
  modelName: 'claude-sonnet-4',
  agentId: 'my-agent-id'
});

// Existing thread with files
await mutation.mutateAsync({
  threadId: 'existing-thread-id',
  prompt: 'More context',
  files: [documentFile],
});
```

## Testing Scenarios

### ✅ Test Case 1: New Thread + Single File
```typescript
await unifiedAgentStart({
  prompt: 'Analyze this PDF',
  files: [pdfFile]
});
```
**Expected:**
- ✅ Project created
- ✅ Sandbox created
- ✅ File uploaded to sandbox
- ✅ Thread created
- ✅ Message includes file reference
- ✅ Agent run started

### ✅ Test Case 2: New Thread + Multiple Files
```typescript
await unifiedAgentStart({
  prompt: 'Process these images',
  files: [img1, img2, img3]
});
```
**Expected:**
- ✅ All files uploaded
- ✅ Message includes all file references
- ✅ Each file has unique name

### ✅ Test Case 3: Existing Thread + Files (No Sandbox Yet)
```typescript
await unifiedAgentStart({
  threadId: 'thread-with-no-sandbox',
  prompt: 'Here is a file',
  files: [newFile]
});
```
**Expected:**
- ✅ Sandbox created for existing thread
- ✅ File uploaded
- ✅ Message created with file reference

### ✅ Test Case 4: Existing Thread + Files (Sandbox Exists)
```typescript
await unifiedAgentStart({
  threadId: 'thread-with-existing-sandbox',
  prompt: 'More files',
  files: [additionalFile]
});
```
**Expected:**
- ✅ Existing sandbox retrieved
- ✅ File uploaded to existing sandbox
- ✅ Message created with file reference

### ✅ Test Case 5: Existing Thread + No Files
```typescript
await unifiedAgentStart({
  threadId: 'existing-thread',
  prompt: 'Continue conversation'
});
```
**Expected:**
- ✅ No sandbox operations
- ✅ Message created with prompt
- ✅ Agent run started

### ✅ Test Case 6: Existing Thread + Just Start (No Prompt, No Files)
```typescript
await unifiedAgentStart({
  threadId: 'existing-thread'
});
```
**Expected:**
- ✅ No message created
- ✅ Agent run started directly

## Error Handling

### File Upload Errors
- Individual file failures are tracked
- Successful uploads still proceed
- Failed files listed in message
- Full sandbox creation failure → HTTP 500

### Sandbox Errors
- Can't retrieve existing sandbox → HTTP 500
- Can't create new sandbox → HTTP 500
- Project cleanup on failure

### Validation Errors
- No prompt for new thread → HTTP 400
- Thread not found → HTTP 404
- No authentication → HTTP 401
- Billing issues → HTTP 402
- Rate limits → HTTP 429

## Performance Considerations

### File Upload
- Files uploaded sequentially (not parallel)
- 200ms delay for verification after each upload
- Verification checks sandbox filesystem

### Sandbox Operations
- Retrieval: ~100-500ms (if already running)
- Creation: ~5-10s (first time)
- Starting stopped sandbox: ~3-5s

## Security

### File Sanitization
- Filenames sanitized (remove `/` and `\`)
- Unique filenames generated to prevent conflicts
- Files uploaded to isolated `/workspace/uploads/` directory

### Access Control
- Thread ownership verified
- User authorization checked
- Sandbox isolated per project

## Limitations

### File Size
- Controlled by FastAPI/Nginx limits
- Default: Depends on server configuration

### File Types
- All file types supported
- No MIME type restrictions at upload level
- Agent decides how to handle different types

### Concurrent Uploads
- Sequential upload (one at a time)
- Future: Could be parallelized for better performance

---

**Status:** ✅ FULLY IMPLEMENTED  
**Date:** 2025-10-25  
**File Upload:** Works for both new and existing threads with automatic sandbox management

