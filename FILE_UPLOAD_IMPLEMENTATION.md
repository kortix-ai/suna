# ✅ File Upload Implementation - Complete

## What Was Fixed

### 🔧 Critical Fix: Existing Sandbox Retrieval

**Problem:** 
The original `_ensure_sandbox_for_thread()` function would return `(None, sandbox_id)` when an existing sandbox was found, making it impossible to upload files to existing threads with sandboxes.

**Solution:**
Updated `_ensure_sandbox_for_thread()` to **always retrieve the sandbox object** when it exists:

```python
# Before (BROKEN):
if existing_sandbox_data and existing_sandbox_data.get('id'):
    logger.debug(f"Project has sandbox, but can't retrieve it")
    return None, existing_sandbox.get('id')  # ❌ No sandbox object!

# After (FIXED):
if existing_sandbox_data and existing_sandbox_data.get('id'):
    sandbox_id = existing_sandbox_data.get('id')
    sandbox = await get_or_start_sandbox(sandbox_id)  # ✅ Get sandbox object!
    return sandbox, sandbox_id
```

### 📦 Added Import

```python
from core.sandbox.sandbox import create_sandbox, delete_sandbox, get_or_start_sandbox
```

Now uses `get_or_start_sandbox()` to retrieve existing sandboxes.

## File Upload Scenarios - All Working ✅

### Scenario 1: New Thread + Files
```typescript
unifiedAgentStart({ 
  prompt: 'Analyze doc', 
  files: [file] 
})
```
✅ Creates sandbox  
✅ Uploads files  
✅ Creates thread  
✅ Message includes file references  

### Scenario 2: Existing Thread (No Sandbox) + Files
```typescript
unifiedAgentStart({ 
  threadId: 'thread-id', 
  files: [file] 
})
```
✅ Creates sandbox for existing thread  
✅ Uploads files  
✅ Message includes file references  

### Scenario 3: Existing Thread (Has Sandbox) + Files
```typescript
unifiedAgentStart({ 
  threadId: 'thread-id', 
  files: [file] 
})
```
✅ **Retrieves existing sandbox**  
✅ **Uploads files to existing sandbox**  
✅ Message includes file references  

### Scenario 4: Existing Thread + No Files
```typescript
unifiedAgentStart({ 
  threadId: 'thread-id',
  prompt: 'Continue chat'
})
```
✅ No sandbox operations  
✅ Creates message  
✅ Starts agent  

### Scenario 5: Just Start Agent (No New Message)
```typescript
unifiedAgentStart({ 
  threadId: 'thread-id' 
})
```
✅ No sandbox operations  
✅ No message created  
✅ Just starts agent  

## File Upload Flow

### Step-by-Step Process

1. **Sandbox Check/Creation**
   ```python
   sandbox, sandbox_id = await _ensure_sandbox_for_thread(client, project_id, files)
   ```
   - Checks if project has sandbox
   - If exists: Retrieves sandbox object via `get_or_start_sandbox()`
   - If not exists + files: Creates new sandbox
   - If not exists + no files: Returns None

2. **File Upload**
   ```python
   message_content = await _handle_file_uploads(files, sandbox, project_id, prompt)
   ```
   - Sanitizes filenames
   - Generates unique names
   - Uploads to `/workspace/uploads/`
   - Verifies each upload
   - Tracks successes and failures

3. **Message Creation**
   ```python
   message_payload = {"role": "user", "content": message_content}
   await client.table('messages').insert({...})
   ```
   - Message includes prompt + file references
   - Format: `[Uploaded File: /workspace/uploads/filename.ext]`

## Code Locations

### Backend
- **Main Endpoint:** `backend/core/agent_runs.py` - `unified_agent_start()`
- **Sandbox Helper:** Line 343-425 - `_ensure_sandbox_for_thread()`
- **Upload Helper:** Line 265-340 - `_handle_file_uploads()`

### Frontend
- **API Function:** `frontend/src/lib/api.ts` - `unifiedAgentStart()`
- **Hook:** `frontend/src/hooks/react-query/dashboard/use-initiate-agent.ts`

### Mobile
- **Hook:** `apps/mobile/lib/chat/hooks.ts` - `useUnifiedAgentStart()`
- **Usage:** `apps/mobile/hooks/useChat.ts` - sendMessage function

## Security & Validation

### File Security
✅ Filename sanitization (no path traversal)  
✅ Unique filenames (no conflicts)  
✅ Isolated sandbox per project  
✅ Proper cleanup on errors  

### Upload Verification
✅ Checks file exists after upload  
✅ 200ms delay for filesystem sync  
✅ Lists directory to verify presence  

## Error Recovery

### If Sandbox Creation Fails
- Project deleted (for new threads)
- Error returned to client
- No orphaned resources

### If File Upload Fails
- Other files still proceed
- Failed files listed in message
- Agent can still process successful uploads

### If Sandbox Retrieval Fails
- HTTP 500 error returned
- Clear error message
- No partial state

## Performance

### Optimizations
- Sandbox only created when needed
- Existing sandboxes reused efficiently
- `get_or_start_sandbox()` handles stopped sandboxes automatically

### Benchmarks (Approximate)
- File upload: ~100-500ms per file
- Sandbox creation: ~5-10s (first time)
- Sandbox retrieval: ~100-500ms (if running)
- Sandbox start: ~3-5s (if stopped)

## Monitoring & Logging

### Key Log Messages

**Sandbox Operations:**
```
[INFO] Created new sandbox {sandbox_id} for project {project_id}
[DEBUG] Project {project_id} already has sandbox {sandbox_id}, retrieving it...
[DEBUG] Successfully retrieved existing sandbox {sandbox_id}
```

**File Uploads:**
```
[DEBUG] Attempting to upload {filename} to {path} in sandbox {sandbox_id}
[DEBUG] Successfully uploaded and verified file {filename}
[ERROR] Verification failed for {filename}: File not found after upload
```

**Errors:**
```
[ERROR] Error retrieving existing sandbox {sandbox_id}: {error}
[ERROR] Error creating sandbox: {error}
[ERROR] Error processing file {filename}: {error}
```

---

**Status:** ✅ FULLY WORKING  
**Date:** 2025-10-25  
**File Uploads:** Supported for ALL scenarios (new threads, existing threads, with/without existing sandboxes)


## What Was Fixed

### 🔧 Critical Fix: Existing Sandbox Retrieval

**Problem:** 
The original `_ensure_sandbox_for_thread()` function would return `(None, sandbox_id)` when an existing sandbox was found, making it impossible to upload files to existing threads with sandboxes.

**Solution:**
Updated `_ensure_sandbox_for_thread()` to **always retrieve the sandbox object** when it exists:

```python
# Before (BROKEN):
if existing_sandbox_data and existing_sandbox_data.get('id'):
    logger.debug(f"Project has sandbox, but can't retrieve it")
    return None, existing_sandbox.get('id')  # ❌ No sandbox object!

# After (FIXED):
if existing_sandbox_data and existing_sandbox_data.get('id'):
    sandbox_id = existing_sandbox_data.get('id')
    sandbox = await get_or_start_sandbox(sandbox_id)  # ✅ Get sandbox object!
    return sandbox, sandbox_id
```

### 📦 Added Import

```python
from core.sandbox.sandbox import create_sandbox, delete_sandbox, get_or_start_sandbox
```

Now uses `get_or_start_sandbox()` to retrieve existing sandboxes.

## File Upload Scenarios - All Working ✅

### Scenario 1: New Thread + Files
```typescript
unifiedAgentStart({ 
  prompt: 'Analyze doc', 
  files: [file] 
})
```
✅ Creates sandbox  
✅ Uploads files  
✅ Creates thread  
✅ Message includes file references  

### Scenario 2: Existing Thread (No Sandbox) + Files
```typescript
unifiedAgentStart({ 
  threadId: 'thread-id', 
  files: [file] 
})
```
✅ Creates sandbox for existing thread  
✅ Uploads files  
✅ Message includes file references  

### Scenario 3: Existing Thread (Has Sandbox) + Files
```typescript
unifiedAgentStart({ 
  threadId: 'thread-id', 
  files: [file] 
})
```
✅ **Retrieves existing sandbox**  
✅ **Uploads files to existing sandbox**  
✅ Message includes file references  

### Scenario 4: Existing Thread + No Files
```typescript
unifiedAgentStart({ 
  threadId: 'thread-id',
  prompt: 'Continue chat'
})
```
✅ No sandbox operations  
✅ Creates message  
✅ Starts agent  

### Scenario 5: Just Start Agent (No New Message)
```typescript
unifiedAgentStart({ 
  threadId: 'thread-id' 
})
```
✅ No sandbox operations  
✅ No message created  
✅ Just starts agent  

## File Upload Flow

### Step-by-Step Process

1. **Sandbox Check/Creation**
   ```python
   sandbox, sandbox_id = await _ensure_sandbox_for_thread(client, project_id, files)
   ```
   - Checks if project has sandbox
   - If exists: Retrieves sandbox object via `get_or_start_sandbox()`
   - If not exists + files: Creates new sandbox
   - If not exists + no files: Returns None

2. **File Upload**
   ```python
   message_content = await _handle_file_uploads(files, sandbox, project_id, prompt)
   ```
   - Sanitizes filenames
   - Generates unique names
   - Uploads to `/workspace/uploads/`
   - Verifies each upload
   - Tracks successes and failures

3. **Message Creation**
   ```python
   message_payload = {"role": "user", "content": message_content}
   await client.table('messages').insert({...})
   ```
   - Message includes prompt + file references
   - Format: `[Uploaded File: /workspace/uploads/filename.ext]`

## Code Locations

### Backend
- **Main Endpoint:** `backend/core/agent_runs.py` - `unified_agent_start()`
- **Sandbox Helper:** Line 343-425 - `_ensure_sandbox_for_thread()`
- **Upload Helper:** Line 265-340 - `_handle_file_uploads()`

### Frontend
- **API Function:** `frontend/src/lib/api.ts` - `unifiedAgentStart()`
- **Hook:** `frontend/src/hooks/react-query/dashboard/use-initiate-agent.ts`

### Mobile
- **Hook:** `apps/mobile/lib/chat/hooks.ts` - `useUnifiedAgentStart()`
- **Usage:** `apps/mobile/hooks/useChat.ts` - sendMessage function

## Security & Validation

### File Security
✅ Filename sanitization (no path traversal)  
✅ Unique filenames (no conflicts)  
✅ Isolated sandbox per project  
✅ Proper cleanup on errors  

### Upload Verification
✅ Checks file exists after upload  
✅ 200ms delay for filesystem sync  
✅ Lists directory to verify presence  

## Error Recovery

### If Sandbox Creation Fails
- Project deleted (for new threads)
- Error returned to client
- No orphaned resources

### If File Upload Fails
- Other files still proceed
- Failed files listed in message
- Agent can still process successful uploads

### If Sandbox Retrieval Fails
- HTTP 500 error returned
- Clear error message
- No partial state

## Performance

### Optimizations
- Sandbox only created when needed
- Existing sandboxes reused efficiently
- `get_or_start_sandbox()` handles stopped sandboxes automatically

### Benchmarks (Approximate)
- File upload: ~100-500ms per file
- Sandbox creation: ~5-10s (first time)
- Sandbox retrieval: ~100-500ms (if running)
- Sandbox start: ~3-5s (if stopped)

## Monitoring & Logging

### Key Log Messages

**Sandbox Operations:**
```
[INFO] Created new sandbox {sandbox_id} for project {project_id}
[DEBUG] Project {project_id} already has sandbox {sandbox_id}, retrieving it...
[DEBUG] Successfully retrieved existing sandbox {sandbox_id}
```

**File Uploads:**
```
[DEBUG] Attempting to upload {filename} to {path} in sandbox {sandbox_id}
[DEBUG] Successfully uploaded and verified file {filename}
[ERROR] Verification failed for {filename}: File not found after upload
```

**Errors:**
```
[ERROR] Error retrieving existing sandbox {sandbox_id}: {error}
[ERROR] Error creating sandbox: {error}
[ERROR] Error processing file {filename}: {error}
```

---

**Status:** ✅ FULLY WORKING  
**Date:** 2025-10-25  
**File Uploads:** Supported for ALL scenarios (new threads, existing threads, with/without existing sandboxes)

