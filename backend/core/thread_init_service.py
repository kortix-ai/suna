import asyncio
import uuid
import traceback
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List
from fastapi import UploadFile
import dramatiq

from core.utils.logger import logger, structlog
from core.services.supabase import DBConnection
from core.utils.project_helpers import generate_and_update_project_name

db = DBConnection()

@dramatiq.actor
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
    
    await db.initialize()
    client = await db.client
    
    try:
        await client.table('threads').update({
            "status": "initializing",
            "initialization_started_at": datetime.now(timezone.utc).isoformat()
        }).eq('thread_id', thread_id).execute()
        
        logger.debug(f"Thread {thread_id} marked as initializing")
        
        await asyncio.sleep(0.1)
        
        from core.ai_models import model_manager
        from run_agent_background import run_agent_background
        
        if model_name is None:
            model_name = await model_manager.get_default_model_for_user(client, account_id)
        else:
            model_name = model_manager.resolve_model_id(model_name)
        
        from core.agent_runs import _load_agent_config, _get_effective_model, _create_agent_run_record
        
        agent_config = await _load_agent_config(client, agent_id, account_id, account_id, is_new_thread=False)
        effective_model = await _get_effective_model(model_name, agent_config, client, account_id)
        agent_run_id = await _create_agent_run_record(client, thread_id, agent_config, effective_model, account_id)
        
        await client.table('threads').update({
            "status": "ready",
            "initialization_completed_at": datetime.now(timezone.utc).isoformat()
        }).eq('thread_id', thread_id).execute()
        
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
        
        try:
            await client.table('threads').update({
                "status": "error",
                "initialization_error": str(e),
                "initialization_completed_at": datetime.now(timezone.utc).isoformat()
            }).eq('thread_id', thread_id).execute()
        except Exception as update_error:
            logger.error(f"Failed to update thread status to error: {str(update_error)}")


async def create_thread_optimistically(
    thread_id: str,
    project_id: str,
    account_id: str,
    prompt: str,
    agent_id: Optional[str] = None,
    model_name: Optional[str] = None,
    files: Optional[List[UploadFile]] = None,
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
    
    if files and len(files) > 0:
        try:
            from core.agent_runs import _ensure_sandbox_for_thread, _handle_file_uploads
            
            logger.info(f"Processing {len(files)} files for optimistic thread {thread_id}")
            sandbox, _ = await _ensure_sandbox_for_thread(client, project_id, files)
            
            if sandbox:
                message_content = await _handle_file_uploads(files, sandbox, project_id, prompt)
                logger.info(f"Successfully uploaded files for thread {thread_id}")
            else:
                logger.warning(f"No sandbox created for thread {thread_id}, files will not be uploaded")
        except Exception as e:
            logger.error(f"Error handling files in optimistic thread creation: {str(e)}\n{traceback.format_exc()}")
            try:
                await client.table('projects').delete().eq('project_id', project_id).execute()
                logger.debug(f"Rolled back project {project_id} due to file handling error")
            except Exception as rollback_error:
                logger.error(f"Failed to rollback project {project_id}: {str(rollback_error)}")
            raise
    
    try:
        await client.table('threads').insert({
            "thread_id": thread_id,
            "project_id": project_id,
            "account_id": account_id,
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        
        logger.debug(f"Created thread {thread_id} with status=pending")
        
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
