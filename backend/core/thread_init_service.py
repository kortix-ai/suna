import asyncio
import uuid
import traceback
import os
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List
from fastapi import UploadFile
import dramatiq

from core.utils.logger import logger, structlog
from core.services.supabase import DBConnection
from core.utils.project_helpers import generate_and_update_project_name
from core.utils.retry import retry_db_operation

# Get queue prefix from environment (for preview deployments)
QUEUE_PREFIX = os.getenv("DRAMATIQ_QUEUE_PREFIX", "")

def get_queue_name(base_name: str) -> str:
    """Get queue name with optional prefix for preview deployments."""
    if QUEUE_PREFIX:
        return f"{QUEUE_PREFIX}{base_name}"
    return base_name

db = DBConnection()

@dramatiq.actor(queue_name=get_queue_name("default"))
async def initialize_thread_background(
    thread_id: str,
    project_id: str,
    account_id: str,
    prompt: str,
    agent_id: Optional[str] = None,
    model_name: Optional[str] = None,
):
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
        project_id=project_id,
        account_id=account_id,
    )
    
    logger.info(f"Starting background thread initialization for thread {thread_id}")
    
    # Initialize DB connection with retry
    await retry_db_operation(
        lambda: db.initialize(),
        f"DB initialization for thread {thread_id}",
        max_retries=3,
        initial_delay=1.0,
        reset_connection_on_error=True,
    )
    
    # Helper async functions to get fresh client on each retry
    async def update_thread_initializing():
        client = await db.client
        return await client.table('threads').update({
            "status": "initializing",
            "initialization_started_at": datetime.now(timezone.utc).isoformat()
        }).eq('thread_id', thread_id).execute()
    
    async def get_default_model():
        from core.ai_models import model_manager
        client = await db.client
        return await model_manager.get_default_model_for_user(client, account_id)
    
    async def load_agent_config():
        from core.agent_runs import _load_agent_config
        client = await db.client
        return await _load_agent_config(client, agent_id, account_id, account_id, is_new_thread=False)
    
    async def get_effective_model(agent_config):
        from core.agent_runs import _get_effective_model
        client = await db.client
        return await _get_effective_model(model_name, agent_config, client, account_id)
    
    async def create_agent_run_record(agent_config, effective_model):
        from core.agent_runs import _create_agent_run_record
        client = await db.client
        return await _create_agent_run_record(client, thread_id, agent_config, effective_model, account_id)
    
    async def update_thread_ready():
        client = await db.client
        return await client.table('threads').update({
            "status": "ready",
            "initialization_completed_at": datetime.now(timezone.utc).isoformat()
        }).eq('thread_id', thread_id).execute()
    
    try:
        # Update thread status to initializing with retry
        # Get fresh client inside function to avoid stale reference after connection reset
        await retry_db_operation(
            update_thread_initializing,
            f"Update thread {thread_id} to initializing",
            max_retries=3,
            initial_delay=1.0,
            reset_connection_on_error=True,
        )
        
        logger.debug(f"Thread {thread_id} marked as initializing")
        
        await asyncio.sleep(0.1)
        
        from core.ai_models import model_manager
        from run_agent_background import run_agent_background
        
        if model_name is None:
            model_name = await retry_db_operation(
                get_default_model,
                f"Get default model for user {account_id}",
                max_retries=3,
                initial_delay=1.0,
            )
        else:
            model_name = model_manager.resolve_model_id(model_name)
        
        agent_config = await retry_db_operation(
            load_agent_config,
            f"Load agent config for thread {thread_id}",
            max_retries=3,
            initial_delay=1.0,
        )
        effective_model = await retry_db_operation(
            lambda: get_effective_model(agent_config),
            f"Get effective model for thread {thread_id}",
            max_retries=3,
            initial_delay=1.0,
        )
        agent_run_id = await retry_db_operation(
            lambda: create_agent_run_record(agent_config, effective_model),
            f"Create agent run record for thread {thread_id}",
            max_retries=3,
            initial_delay=1.0,
        )
        
        # Update thread status to ready with retry
        # Get fresh client inside function to avoid stale reference after connection reset
        await retry_db_operation(
            update_thread_ready,
            f"Update thread {thread_id} to ready",
            max_retries=3,
            initial_delay=1.0,
            reset_connection_on_error=True,
        )
        
        logger.info(f"Thread {thread_id} marked as ready, dispatching agent: {agent_run_id}")
        
        worker_instance_id = str(uuid.uuid4())[:8]
        
        run_agent_background.send(
            agent_run_id=agent_run_id,
            thread_id=thread_id,
            instance_id=worker_instance_id,
            project_id=project_id,
            model_name=effective_model,
            agent_id=agent_id,
            account_id=account_id,
        )
        
        logger.info(f"Thread {thread_id} initialization completed and agent dispatched: {agent_run_id}")
        
    except Exception as e:
        logger.error(f"Thread initialization failed for {thread_id}: {str(e)}\n{traceback.format_exc()}")
        
        # Try to update thread status to error with retry
        # Get fresh client inside function to avoid stale reference after connection reset
        async def update_thread_error():
            client = await db.client
            return await client.table('threads').update({
                "status": "error",
                "initialization_error": str(e)[:1000],  # Truncate error message to avoid DB limits
                "initialization_completed_at": datetime.now(timezone.utc).isoformat()
            }).eq('thread_id', thread_id).execute()
        
        try:
            await retry_db_operation(
                update_thread_error,
                f"Update thread {thread_id} to error status",
                max_retries=2,  # Fewer retries for error updates
                initial_delay=0.5,
            )
        except Exception as update_error:
            logger.error(f"Failed to update thread status to error after retries: {str(update_error)}")


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
    if not db._client:
        await db.initialize()
    client = await db.client
    
    placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
    message_content = prompt
    
    try:
        await client.table('projects').insert({
            "project_id": project_id,
            "account_id": account_id,
            "name": placeholder_name,
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        
        logger.debug(f"Created project {project_id} optimistically")
        
        asyncio.create_task(generate_and_update_project_name(project_id=project_id, prompt=prompt))
        
    except Exception as e:
        logger.error(f"Failed to create project optimistically: {str(e)}")
        raise
    
    image_urls_for_context = []
    
    if staged_files and len(staged_files) > 0:
        try:
            from core.agent_runs import _upload_staged_files_to_sandbox_background
            from core.services import redis
            import json
            
            logger.info(f"Using {len(staged_files)} pre-staged files for optimistic thread {thread_id}")
            
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
                logger.info(f"✅ Cached {len(parsed_contents)} staged files for thread {thread_id}")
            
            await _upload_staged_files_to_sandbox_background(
                project_id=project_id,
                thread_id=thread_id,
                staged_files=staged_files,
                account_id=account_id
            )
            logger.info(f"✅ Completed sandbox upload for {len(staged_files)} staged files")
            
        except Exception as e:
            logger.error(f"Error processing staged files: {str(e)}\n{traceback.format_exc()}")
    
    elif files and len(files) > 0:
        try:
            from core.agent_runs import _handle_file_uploads_fast
            
            logger.info(f"Fast-processing {len(files)} files for optimistic thread {thread_id}")
            message_content = await _handle_file_uploads_fast(files, project_id, prompt, thread_id)
            logger.info(f"Fast-parsed files for thread {thread_id}, sandbox upload scheduled in background")
        except Exception as e:
            logger.error(f"Error fast-parsing files in optimistic thread creation: {str(e)}\n{traceback.format_exc()}")
            try:
                await client.table('projects').delete().eq('project_id', project_id).execute()
                logger.debug(f"Rolled back project {project_id} due to file handling error")
            except Exception as rollback_error:
                logger.error(f"Failed to rollback project {project_id}: {str(rollback_error)}")
            raise
    
    try:
        # Create thread with default name, will be updated by LLM in background
        thread_data = {
            "thread_id": thread_id,
            "project_id": project_id,
            "account_id": account_id,
            "name": "New Chat",
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        if memory_enabled is not None:
            thread_data["memory_enabled"] = memory_enabled
        
        await client.table('threads').insert(thread_data).execute()
        
        logger.debug(f"Created thread {thread_id} with default name, status=pending, memory_enabled={memory_enabled}")
        
        # Generate proper thread name in background using LLM (fire-and-forget)
        if prompt:
            from core.utils.thread_name_generator import generate_and_update_thread_name
            asyncio.create_task(generate_and_update_thread_name(thread_id=thread_id, prompt=prompt))
        
    except Exception as e:
        logger.error(f"Failed to create thread optimistically: {str(e)}")
        
        try:
            await client.table('projects').delete().eq('project_id', project_id).execute()
            logger.debug(f"Rolled back project {project_id}")
        except Exception as rollback_error:
            logger.error(f"Failed to rollback project {project_id}: {str(rollback_error)}")
        
        raise
    
    await client.table('messages').insert({
        "message_id": str(uuid.uuid4()),
        "thread_id": thread_id,
        "type": "user",
        "is_llm_message": True,
        "content": {"role": "user", "content": message_content},
        "created_at": datetime.now(timezone.utc).isoformat()
    }).execute()
    
    logger.debug(f"Created user message for thread {thread_id} with content length: {len(message_content)}")
    
    for img_info in image_urls_for_context:
        try:
            image_message_content = {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"[Image loaded: {img_info['filename']}]"},
                    {"type": "image_url", "image_url": {"url": img_info['url']}}
                ]
            }
            
            await client.table('messages').insert({
                "message_id": str(uuid.uuid4()),
                "thread_id": thread_id,
                "type": "image_context",
                "is_llm_message": True,
                "content": image_message_content,
                "metadata": {
                    "file_path": img_info['filename'],
                    "mime_type": img_info['mime_type'],
                    "source": "user_upload"
                },
                "created_at": datetime.now(timezone.utc).isoformat()
            }).execute()
            
            logger.info(f"📷 Injected image context for {img_info['filename']} into thread {thread_id}")
        except Exception as img_error:
            logger.warning(f"Failed to inject image context for {img_info['filename']}: {img_error}")
    
    initialize_thread_background.send(
        thread_id=thread_id,
        project_id=project_id,
        account_id=account_id,
        prompt=prompt,
        agent_id=agent_id,
        model_name=model_name,
    )
    
    logger.info(f"Dispatched background initialization for thread {thread_id}")
    
    return {
        "thread_id": thread_id,
        "project_id": project_id,
        "status": "pending"
    }
