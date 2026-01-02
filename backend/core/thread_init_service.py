import asyncio
import uuid
import traceback
import os
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List
from fastapi import UploadFile

from core.utils.logger import logger, structlog
from core.services.supabase import DBConnection
from core.utils.project_helpers import generate_and_update_project_name
from core.utils.retry import retry_db_operation
from core.temporal.client import get_temporal_client
# Import ThreadInitWorkflow inside function to avoid circular import

db = DBConnection()

async def initialize_thread_background(
    thread_id: str,
    project_id: str,
    account_id: str,
    prompt: str,
    agent_id: Optional[str] = None,
    model_name: Optional[str] = None,
):
    """
    Initialize thread and start agent run directly.
    
    This is a simplified flow that:
    1. Creates agent_run record (quick DB operation)
    2. Starts AgentRunWorkflow via Temporal (for the long-running agent execution)
    
    No need for a separate ThreadInitWorkflow - that was over-engineered.
    """
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
        project_id=project_id,
        account_id=account_id,
    )
    
    logger.info(f"Initializing thread and starting agent: {thread_id}")
    
    try:
        from core.temporal.workflows import AgentRunWorkflow, TASK_QUEUE_AGENT_RUNS
        from core.agent_runs import _load_agent_config, _get_effective_model, _create_agent_run_record
        from core.ai_models import model_manager
        from core.services import redis
        import time
        
        # Initialize DB
        if not db._client:
            await db.initialize()
        client = await db.client
        
        # Update thread status to initializing
        await client.table('threads').update({
            "status": "initializing",
            "initialization_started_at": datetime.now(timezone.utc).isoformat()
        }).eq('thread_id', thread_id).execute()
        
        # Get effective model
        if model_name is None:
            model_name = await model_manager.get_default_model_for_user(client, account_id)
        else:
            model_name = model_manager.resolve_model_id(model_name)
        
        # Load agent config and create agent run record
        agent_config = await _load_agent_config(client, agent_id, account_id, account_id, is_new_thread=False)
        effective_model = await _get_effective_model(model_name, agent_config, client, account_id)
        agent_run_id = await _create_agent_run_record(client, thread_id, agent_config, effective_model, account_id)
        
        # Update thread status to ready
        await client.table('threads').update({
            "status": "ready",
            "initialization_completed_at": datetime.now(timezone.utc).isoformat()
        }).eq('thread_id', thread_id).execute()
        
        # Pre-create Redis stream so frontend can subscribe immediately
        stream_key = f"agent_run:{agent_run_id}:stream"
        await redis.verify_stream_writable(stream_key)
        
        # #region agent log
        try:
            import urllib.request as _ur; _ur.urlopen(_ur.Request('http://host.docker.internal:7242/ingest/8574b837-03d2-4ece-8422-988bb17343e8',data=__import__('json').dumps({"location":"thread_init_service.py:init_done","message":"Thread init complete, starting AgentRunWorkflow","data":{"thread_id":thread_id,"agent_run_id":agent_run_id},"timestamp":time.time()*1000,"sessionId":"debug-session","hypothesisId":"FIX"}).encode(),headers={'Content-Type':'application/json'}),timeout=1)
        except: pass
        # #endregion
        
        logger.info(f"Thread {thread_id} initialized, agent_run_id: {agent_run_id}")
        
        # Start AgentRunWorkflow directly via Temporal
        temporal_client = await get_temporal_client()
        worker_instance_id = str(uuid.uuid4())[:8]
        
        agent_handle = await temporal_client.start_workflow(
            AgentRunWorkflow.run,
            args=[agent_run_id, thread_id, worker_instance_id, project_id, effective_model, agent_id, account_id, None],
            id=f"agent-run-{agent_run_id}",
            task_queue=TASK_QUEUE_AGENT_RUNS,
        )
        
        # #region agent log
        try:
            import urllib.request as _ur; _ur.urlopen(_ur.Request('http://host.docker.internal:7242/ingest/8574b837-03d2-4ece-8422-988bb17343e8',data=__import__('json').dumps({"location":"thread_init_service.py:workflow_started","message":"AgentRunWorkflow STARTED","data":{"agent_run_id":agent_run_id,"workflow_id":agent_handle.id},"timestamp":time.time()*1000,"sessionId":"debug-session","hypothesisId":"FIX"}).encode(),headers={'Content-Type':'application/json'}),timeout=1)
        except: pass
        # #endregion
        
        logger.info(f"Started AgentRunWorkflow: {agent_handle.id}")
        return agent_handle
        
    except Exception as e:
        logger.error(f"Thread initialization failed for {thread_id}: {str(e)}\n{traceback.format_exc()}")
        
        # Try to update thread status to error
        try:
            await retry_db_operation(
                lambda: db.initialize(),
                f"DB initialization for error update",
                max_retries=2,
                initial_delay=0.5,
            )
            client = await db.client
            
            async def update_thread_error():
                client = await db.client
                return await client.table('threads').update({
                    "status": "error",
                    "initialization_error": str(e)[:1000],
                    "initialization_completed_at": datetime.now(timezone.utc).isoformat()
                }).eq('thread_id', thread_id).execute()
            
            await retry_db_operation(
                update_thread_error,
                f"Update thread {thread_id} to error status",
                max_retries=2,
                initial_delay=0.5,
            )
        except Exception as update_error:
            logger.error(f"Failed to update thread status to error: {str(update_error)}")
        
        raise


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
    
    asyncio.create_task(initialize_thread_background(
        thread_id=thread_id,
        project_id=project_id,
        account_id=account_id,
        prompt=prompt,
        agent_id=agent_id,
        model_name=model_name,
    ))
    
    logger.info(f"Dispatched background initialization for thread {thread_id}")
    
    return {
        "thread_id": thread_id,
        "project_id": project_id,
        "status": "pending"
    }
