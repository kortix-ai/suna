"""
Thread initialization service.

This module handles:
- Optimistic thread creation (immediate response to client)
- Background thread initialization dispatch via Redis Streams
"""

import asyncio
import uuid
import traceback
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List
from fastapi import UploadFile

from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.utils.project_helpers import generate_and_update_project_name

db = DBConnection()


async def create_thread_optimistically(
    thread_id: str,
    project_id: str,
    account_id: str,
    prompt: str,
    agent_id: Optional[str] = None,
    model_name: Optional[str] = None,
    files: Optional[List[UploadFile]] = None,
    staged_files: Optional[List[Dict[str, Any]]] = None,
    memory_enabled: Optional[bool] = None,
) -> Dict[str, Any]:
    """
    Create a thread optimistically and dispatch background initialization.
    
    Returns immediately with thread_id while initialization happens in background.
    """
    import time
    t_start = time.time()
    
    if not db._client:
        await db.initialize()
    client = await db.client
    
    placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
    message_content = prompt
    now_iso = datetime.now(timezone.utc).isoformat()
    
    # Prepare thread data early
    thread_data = {
        "thread_id": thread_id,
        "project_id": project_id,
        "account_id": account_id,
        "name": "New Chat",
        "status": "pending",
        "created_at": now_iso
    }
    if memory_enabled is not None:
        thread_data["memory_enabled"] = memory_enabled
    
    project_data = {
        "project_id": project_id,
        "account_id": account_id,
        "name": placeholder_name,
        "created_at": now_iso
    }
    
    # Create project first, then thread (FK constraint requires project to exist)
    try:
        await client.table('projects').insert(project_data).execute()
        logger.debug(f"Created project {project_id}")
        
        await client.table('threads').insert(thread_data).execute()
        logger.debug(f"Created thread {thread_id}")
        
        # Fire-and-forget name generation (don't block)
        asyncio.create_task(generate_and_update_project_name(project_id=project_id, prompt=prompt))
        if prompt:
            from core.utils.thread_name_generator import generate_and_update_thread_name
            asyncio.create_task(generate_and_update_thread_name(thread_id=thread_id, prompt=prompt))
        
        logger.debug(f"⏱️ [TIMING] Sequential project+thread insert: {(time.time() - t_start) * 1000:.1f}ms")
        
    except Exception as e:
        logger.error(f"Failed to create project/thread: {e}")
        raise
    
    image_urls_for_context = []
    
    # Handle staged files
    if staged_files and len(staged_files) > 0:
        try:
            from core.agents.runs import _upload_staged_files_to_sandbox_background
            from core.services import redis
            import json
            
            logger.info(f"Using {len(staged_files)} staged files for thread {thread_id}")
            
            file_refs = []
            parsed_contents = []
            for sf in staged_files:
                filename = sf['filename']
                
                if sf.get('image_url'):
                    image_urls_for_context.append({
                        "filename": filename,
                        "url": sf['image_url'],
                        "mime_type": sf['mime_type']
                    })
                    file_refs.append(f"[Image: {filename} ({sf['file_size']:,} bytes) -> uploads/{filename}]")
                else:
                    file_refs.append(f"[Attached: {filename} ({sf['file_size']:,} bytes) -> uploads/{filename}]")
                    if sf.get('parsed_content'):
                        parsed_contents.append({
                            "filename": filename,
                            "content": sf['parsed_content'],
                            "mime_type": sf['mime_type'],
                            "size": sf['file_size']
                        })
            
            message_content = prompt + "\n\n" + "\n".join(file_refs) if file_refs else prompt
            
            if parsed_contents:
                cache_key = f"file_context:{thread_id}"
                await redis.set(cache_key, json.dumps(parsed_contents), ex=3600)
            
            await _upload_staged_files_to_sandbox_background(
                project_id=project_id,
                thread_id=thread_id,
                staged_files=staged_files,
                account_id=account_id
            )
            
        except Exception as e:
            logger.error(f"Error processing staged files: {e}\n{traceback.format_exc()}")
    
    # Handle uploaded files
    elif files and len(files) > 0:
        try:
            from core.agents.runs import _handle_file_uploads_fast
            
            logger.info(f"Processing {len(files)} files for thread {thread_id}")
            message_content = await _handle_file_uploads_fast(files, project_id, prompt, thread_id)
        except Exception as e:
            logger.error(f"Error processing files: {e}\n{traceback.format_exc()}")
            # Cleanup both project and thread on failure
            try:
                await asyncio.gather(
                    client.table('projects').delete().eq('project_id', project_id).execute(),
                    client.table('threads').delete().eq('thread_id', thread_id).execute(),
                    return_exceptions=True
                )
            except:
                pass
            raise
    
    # Create user message AND dispatch to worker in parallel for faster TTFT
    from core.worker import dispatch_thread_init
    
    async def insert_user_message():
        await client.table('messages').insert({
            "message_id": str(uuid.uuid4()),
            "thread_id": thread_id,
            "type": "user",
            "is_llm_message": True,
            "content": {"role": "user", "content": message_content},
            "created_at": now_iso
        }).execute()
    
    async def dispatch_to_worker():
        await dispatch_thread_init(
            thread_id=thread_id,
            project_id=project_id,
            account_id=account_id,
            prompt=prompt,
            agent_id=agent_id,
            model_name=model_name,
        )
    
    t_parallel = time.time()
    await asyncio.gather(insert_user_message(), dispatch_to_worker())
    logger.debug(f"⏱️ [TIMING] Parallel msg+dispatch: {(time.time() - t_parallel) * 1000:.1f}ms")
    
    # Add image context messages in background (don't block return)
    if image_urls_for_context:
        async def insert_image_contexts():
            for img_info in image_urls_for_context:
                try:
                    await client.table('messages').insert({
                        "message_id": str(uuid.uuid4()),
                        "thread_id": thread_id,
                        "type": "image_context",
                        "is_llm_message": True,
                        "content": {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": f"[Image: {img_info['filename']}]"},
                                {"type": "image_url", "image_url": {"url": img_info['url']}}
                            ]
                        },
                        "metadata": {
                            "file_path": img_info['filename'],
                            "mime_type": img_info['mime_type'],
                            "source": "user_upload"
                        },
                        "created_at": now_iso
                    }).execute()
                except Exception as e:
                    logger.warning(f"Failed to inject image context: {e}")
        asyncio.create_task(insert_image_contexts())
    
    logger.info(f"⏱️ [TIMING] Thread init total: {(time.time() - t_start) * 1000:.1f}ms")
    
    return {
        "thread_id": thread_id,
        "project_id": project_id,
        "status": "pending"
    }
