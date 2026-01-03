import asyncio
import json
import traceback
import uuid
import os
from datetime import datetime, timezone
from typing import Optional, List, Tuple, Dict, Any
from fastapi import APIRouter, HTTPException, Depends, Query, Request, Body, File, UploadFile, Form
from fastapi.responses import StreamingResponse
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, get_user_id_from_stream_auth, verify_and_authorize_thread_access
from core.utils.logger import logger, structlog
from core.billing.credits.integration import billing_integration
from core.utils.config import config, EnvMode
from core.services import redis
from core.sandbox.sandbox import create_sandbox, delete_sandbox, get_or_start_sandbox
from core.utils.sandbox_utils import generate_unique_filename, get_uploads_directory
from core.temporal.client import get_temporal_client
from core.temporal.workflows import AgentRunWorkflow, TASK_QUEUE_AGENT_RUNS

from core.ai_models import model_manager

from .api_models import AgentVersionResponse, AgentResponse, UnifiedAgentStartResponse
from . import core_utils as utils

from .core_utils import (
    stop_agent_run_with_helpers as stop_agent_run,
    _get_version_service, generate_and_update_project_name,
    check_agent_run_limit, check_project_count_limit
)

router = APIRouter(tags=["agent-runs"])

async def _get_agent_run_with_access_check(client, agent_run_id: str, user_id: str):
    from core.utils.auth_utils import verify_and_authorize_thread_access
    
    agent_run = await client.table('agent_runs').select('*, threads(account_id)').eq('id', agent_run_id).execute()
    if not agent_run.data:
        raise HTTPException(status_code=404, detail="Worker run not found")

    agent_run_data = agent_run.data[0]
    thread_id = agent_run_data['thread_id']
    account_id = agent_run_data['threads']['account_id']
    
    metadata = agent_run_data.get('metadata', {})
    actual_user_id = metadata.get('actual_user_id')
    
    if actual_user_id and actual_user_id == user_id:
        return agent_run_data
    
    if account_id == user_id:
        return agent_run_data
        
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    return agent_run_data


async def _find_shared_suna_agent(client):
    from .agent_loader import get_agent_loader
    from core.utils.config import config
    
    admin_user_id = config.SYSTEM_ADMIN_USER_ID
    
    if admin_user_id:
        admin_suna = await client.table('agents').select('agent_id').eq('account_id', admin_user_id).eq('metadata->>is_suna_default', 'true').maybe_single().execute()
        
        if admin_suna and admin_suna.data:
            loader = await get_agent_loader()
            agent_data = await loader.load_agent(admin_suna.data['agent_id'], admin_user_id, load_config=True)
            logger.info(f"✅ Using system Suna agent from admin user: {agent_data.name} ({agent_data.agent_id})")
            return agent_data
        else:
            logger.warning(f"⚠️ SYSTEM_ADMIN_USER_ID configured but no Suna agent found for user {admin_user_id}")
    
    any_suna = await client.table('agents').select('agent_id, account_id').eq('metadata->>is_suna_default', 'true').limit(1).maybe_single().execute()
    
    if any_suna and any_suna.data:
        loader = await get_agent_loader()
        agent_data = await loader.load_agent(any_suna.data['agent_id'], any_suna.data['account_id'], load_config=True)
        logger.info(f"Using shared Suna agent: {agent_data.name} ({agent_data.agent_id})")
        return agent_data
    
    logger.error("❌ No Suna agent found! Set SYSTEM_ADMIN_USER_ID in .env")
    return None


async def _check_billing_and_limits(client, account_id: str, model_name: Optional[str], check_project_limit: bool = False, check_thread_limit: bool = False):
    import time
    from core.utils.limits_checker import check_thread_limit as _check_thread_limit
    t_start = time.time()
    
    async def check_billing():
        if model_name == "mock-ai":
            return (True, None, {})
        return await billing_integration.check_model_and_billing_access(
            account_id, model_name, client
        )
    
    async def check_agent_runs():
        if config.ENV_MODE == EnvMode.LOCAL:
            return {'can_start': True}
        return await check_agent_run_limit(client, account_id)
    
    async def check_projects():
        if config.ENV_MODE == EnvMode.LOCAL or not check_project_limit:
            return {'can_create': True}
        return await check_project_count_limit(client, account_id)
    
    async def check_threads():
        if config.ENV_MODE == EnvMode.LOCAL or not check_thread_limit:
            return {'can_create': True}
        return await _check_thread_limit(client, account_id)
    
    billing_result, agent_run_result, project_result, thread_result = await asyncio.gather(
        check_billing(),
        check_agent_runs(),
        check_projects(),
        check_threads()
    )
    
    logger.debug(f"⏱️ [TIMING] Parallel billing/limit checks: {(time.time() - t_start) * 1000:.1f}ms")
    
    can_proceed, error_message, context = billing_result
    if not can_proceed:
        if context.get("error_type") == "model_access_denied":
            raise HTTPException(status_code=402, detail={
                "message": error_message, 
                "tier_name": context.get("tier_name"),
                "error_code": "MODEL_ACCESS_DENIED"
            })
        elif context.get("error_type") == "insufficient_credits":
            raise HTTPException(status_code=402, detail={
                "message": error_message,
                "error_code": "INSUFFICIENT_CREDITS"
            })
        else:
            raise HTTPException(status_code=500, detail={"message": error_message})
    
    if not agent_run_result.get('can_start', True):
        error_detail = {
            "message": f"Maximum of {agent_run_result['limit']} concurrent agent runs allowed. You currently have {agent_run_result['running_count']} running.",
            "running_thread_ids": agent_run_result.get('running_thread_ids', []),
            "running_count": agent_run_result['running_count'],
            "limit": agent_run_result['limit'],
            "error_code": "AGENT_RUN_LIMIT_EXCEEDED"
        }
        logger.warning(f"Agent run limit exceeded for account {account_id}: {agent_run_result['running_count']}/{agent_run_result['limit']} running agents")
        raise HTTPException(status_code=402, detail=error_detail)

    if check_project_limit and not project_result.get('can_create', True):
        error_detail = {
            "message": f"Maximum of {project_result['limit']} projects allowed for your current plan. You have {project_result['current_count']} projects.",
            "current_count": project_result['current_count'],
            "limit": project_result['limit'],
            "tier_name": project_result['tier_name'],
            "error_code": "PROJECT_LIMIT_EXCEEDED"
        }
        logger.warning(f"Project limit exceeded for account {account_id}: {project_result['current_count']}/{project_result['limit']} projects")
        raise HTTPException(status_code=402, detail=error_detail)
    
    if check_thread_limit and not thread_result.get('can_create', True):
        error_detail = {
            "message": f"Maximum of {thread_result['limit']} threads allowed for your current plan. You have {thread_result['current_count']} threads.",
            "current_count": thread_result['current_count'],
            "limit": thread_result['limit'],
            "tier_name": thread_result['tier_name'],
            "error_code": "THREAD_LIMIT_EXCEEDED"
        }
        logger.warning(f"Thread limit exceeded for account {account_id}: {thread_result['current_count']}/{thread_result['limit']} threads")
        raise HTTPException(status_code=402, detail=error_detail)




async def _fast_parse_files(files: List[UploadFile], prompt: str = "") -> Tuple[str, List[Tuple[str, bytes, str, Optional[str]]]]:
    from core.utils.fast_parse import parse, FileType, format_file_size
    import re
    
    if not files:
        return prompt, []
    
    message_content = prompt
    files_for_upload: List[Tuple[str, bytes, str, Optional[str]]] = []
    file_refs = []
    
    # Extract existing file references from prompt to avoid duplicates
    existing_refs = set()
    if prompt:
        # Match both [Uploaded File: ...] and [Attached: ...] patterns
        existing_matches = re.findall(r'\[(?:Uploaded File|Attached|Image):\s*([^\]]+)\]', prompt)
        for match in existing_matches:
            # Normalize path (strip /workspace/ prefix if present)
            normalized = match.replace('/workspace/', '') if match.startswith('/workspace/') else match
            existing_refs.add(normalized.lower())
    
    for file in files:
        if not file.filename:
            continue
        
        try:
            original_filename = file.filename.replace('/', '_').replace('\\', '_')
            content_bytes = await file.read()
            mime_type = file.content_type or "application/octet-stream"
            
            result = parse(content_bytes, original_filename, mime_type)
            
            parsed_content = None
            if result.success and result.file_type != FileType.IMAGE:
                parsed_content = result.content
                if len(parsed_content) > 100000:
                    parsed_content = parsed_content[:100000]
            
            files_for_upload.append((original_filename, content_bytes, mime_type, parsed_content))
            
            # Check if this file is already referenced in the prompt
            file_path = f"uploads/{original_filename}"
            if file_path.lower() not in existing_refs:
                file_refs.append(f"[Attached: {original_filename} ({format_file_size(result.file_size)}) -> {file_path}]")
            
            logger.debug(f"Fast-parsed {original_filename}: {result.char_count} chars, type={result.file_type.name}")
                
        except Exception as e:
            logger.error(f"Error fast-parsing file {file.filename}: {str(e)}", exc_info=True)
            file_path = f"uploads/{file.filename}"
            if file_path.lower() not in existing_refs:
                file_refs.append(f"[Attached: {file.filename} -> {file_path}]")
        finally:
            await file.seek(0)
    
    if file_refs:
        message_content = prompt + "\n\n" + "\n".join(file_refs) if prompt else "\n".join(file_refs)
    
    return message_content, files_for_upload


async def _upload_files_to_sandbox_background(
    project_id: str,
    thread_id: str,
    files_data: List[Tuple[str, bytes, str, Optional[str]]],
):
    if not files_data:
        return
    
    logger.info(f"🔄 Background sandbox activity starting for project {project_id} ({len(files_data)} files)")
    
    try:
        client = await utils.db.client
        
        sandbox, sandbox_id = await _ensure_sandbox_for_thread(client, project_id, files_data)
        
        if not sandbox:
            logger.info(f"⚠️ Sandbox not available for project {project_id} - files cached in Redis, sandbox upload skipped")
            return
        
        logger.info(f"✅ Sandbox {sandbox_id} ready for project {project_id}, uploading {len(files_data)} files...")
        uploads_dir = get_uploads_directory()
        uploaded_count = 0
        
        for filename, content_bytes, mime_type, _ in files_data:
            try:
                unique_filename = await generate_unique_filename(sandbox, uploads_dir, filename)
                target_path = f"{uploads_dir}/{unique_filename}"
                
                if hasattr(sandbox, 'fs') and hasattr(sandbox.fs, 'upload_file'):
                    await sandbox.fs.upload_file(content_bytes, target_path)
                    uploaded_count += 1
                    logger.debug(f"Background upload complete: {filename} -> {target_path}")
                else:
                    logger.warning(f"Sandbox missing upload method for {filename}")
            except Exception as e:
                logger.warning(f"Background upload failed for {filename}: {str(e)}")
        
        logger.info(f"✅ Background sandbox upload complete: {uploaded_count}/{len(files_data)} files to sandbox {sandbox_id}")
                
    except Exception as e:
        logger.warning(f"⚠️ Sandbox upload error for project {project_id}: {str(e)} - files still available via Redis cache")


async def _upload_staged_files_to_sandbox_background(
    project_id: str,
    thread_id: str,
    staged_files: List[Dict[str, Any]],
    account_id: str,
):
    if not staged_files:
        return
    
    logger.info(f"🔄 Background staged files -> sandbox upload starting for project {project_id} ({len(staged_files)} files)")
    
    try:
        from core.files import get_staged_file_content
        
        client = await utils.db.client
        
        files_data = []
        for sf in staged_files:
            content_bytes = await get_staged_file_content(sf['file_id'], account_id)
            if content_bytes:
                files_data.append((
                    sf['filename'],
                    content_bytes,
                    sf['mime_type'],
                    sf.get('parsed_content')
                ))
            else:
                logger.warning(f"Could not download staged file {sf['file_id']} for sandbox upload")
        
        if not files_data:
            logger.warning(f"No staged files could be downloaded for sandbox upload")
            return
        
        sandbox, sandbox_id = await _ensure_sandbox_for_thread(client, project_id, files_data)
        
        if not sandbox:
            logger.info(f"⚠️ Sandbox not available for project {project_id} - sandbox upload skipped")
            return
        
        logger.info(f"✅ Sandbox {sandbox_id} ready for project {project_id}, uploading {len(files_data)} staged files...")
        uploads_dir = get_uploads_directory()
        uploaded_count = 0
        
        for filename, content_bytes, mime_type, _ in files_data:
            try:
                unique_filename = await generate_unique_filename(sandbox, uploads_dir, filename)
                target_path = f"{uploads_dir}/{unique_filename}"
                
                if hasattr(sandbox, 'fs') and hasattr(sandbox.fs, 'upload_file'):
                    await sandbox.fs.upload_file(content_bytes, target_path)
                    uploaded_count += 1
                    logger.debug(f"Background staged file upload complete: {filename} -> {target_path}")
                else:
                    logger.warning(f"Sandbox missing upload method for {filename}")
            except Exception as e:
                logger.warning(f"Background staged file upload failed for {filename}: {str(e)}")
        
        logger.info(f"✅ Background staged files upload complete: {uploaded_count}/{len(files_data)} files to sandbox {sandbox_id}")
                
    except Exception as e:
        logger.warning(f"⚠️ Staged files sandbox upload error for project {project_id}: {str(e)}")


async def get_cached_file_context(thread_id: str) -> Optional[List[Dict[str, Any]]]:
    try:
        cache_key = f"file_context:{thread_id}"
        cached = await redis.get(cache_key)
        if cached:
            return json.loads(cached)
    except Exception as e:
        logger.warning(f"Failed to retrieve cached file context for {thread_id}: {e}")
    return None


def format_file_context_for_agent(files: List[Dict[str, Any]]) -> str:
    if not files:
        return ""
    
    parts = ["\n\n--- ATTACHED FILE CONTENTS ---"]
    for f in files:
        filename = f.get("filename", "unknown")
        content = f.get("content", "")
        size = f.get("size", 0)
        
        if content:
            parts.append(f"\n### {filename} ({size:,} bytes)\n```\n{content}\n```")
    
    parts.append("\n--- END OF ATTACHED FILES ---\n")
    return "\n".join(parts)


async def _handle_file_uploads_fast(
    files: List[UploadFile],
    project_id: str,
    prompt: str = "",
    thread_id: Optional[str] = None,
) -> str:
    message_content, files_data = await _fast_parse_files(files, prompt)
    
    if files_data:
        tid = thread_id or project_id
        
        parsed_contents = []
        for filename, content_bytes, mime_type, parsed_content in files_data:
            if parsed_content:
                parsed_contents.append({
                    "filename": filename,
                    "content": parsed_content,
                    "mime_type": mime_type,
                    "size": len(content_bytes)
                })
        
        if parsed_contents:
            try:
                cache_key = f"file_context:{tid}"
                await redis.set(cache_key, json.dumps(parsed_contents), ex=3600)
                logger.info(f"✅ Cached {len(parsed_contents)} parsed files for thread {tid}")
            except Exception as cache_error:
                logger.warning(f"Failed to cache parsed files: {cache_error}")
        
        if project_id:
            asyncio.create_task(_upload_files_to_sandbox_background(project_id, tid, files_data))
            logger.debug(f"Scheduled background sandbox upload for {len(files_data)} files")
    
    return message_content


async def _handle_staged_files_for_thread(
    staged_files: List[Dict[str, Any]],
    thread_id: str,
    project_id: str,
    prompt: str,
    account_id: str,
) -> Tuple[str, List[Dict[str, Any]]]:
    file_refs = []
    parsed_contents = []
    image_contexts = []
    
    for sf in staged_files:
        filename = sf['filename']
        
        if sf.get('image_url'):
            image_contexts.append({
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
        try:
            cache_key = f"file_context:{thread_id}"
            await redis.set(cache_key, json.dumps(parsed_contents), ex=3600)
            logger.info(f"✅ Cached {len(parsed_contents)} staged files for thread {thread_id}")
        except Exception as cache_error:
            logger.warning(f"Failed to cache staged files: {cache_error}")
    
    asyncio.create_task(_upload_staged_files_to_sandbox_background(
        project_id=project_id,
        thread_id=thread_id,
        staged_files=staged_files,
        account_id=account_id
    ))
    logger.debug(f"Scheduled background sandbox upload for {len(staged_files)} staged files")
    
    return message_content, image_contexts


async def _ensure_sandbox_for_thread(client, project_id: str, files: Optional[List[Any]] = None):
    from core.resources import ResourceService, ResourceType, ResourceStatus
    
    project_result = await client.table('projects').select('project_id, account_id, sandbox_resource_id').eq('project_id', project_id).execute()
    
    if not project_result.data:
        logger.warning(f"Project {project_id} not found when checking for sandbox")
        return None, None
    
    project_data = project_result.data[0]
    account_id = project_data.get('account_id')
    sandbox_resource_id = project_data.get('sandbox_resource_id')
    
    resource_service = ResourceService(client)
    
    # Try to get existing sandbox resource
    sandbox_resource = None
    if sandbox_resource_id:
        sandbox_resource = await resource_service.get_resource_by_id(sandbox_resource_id)
    
    if sandbox_resource and sandbox_resource.get('status') == ResourceStatus.ACTIVE.value:
        sandbox_id = sandbox_resource.get('external_id')
        logger.debug(f"Project {project_id} already has sandbox {sandbox_id}, retrieving it...")
        
        try:
            sandbox = await get_or_start_sandbox(sandbox_id)
            logger.debug(f"Successfully retrieved existing sandbox {sandbox_id}")
            # Update last_used_at
            try:
                await resource_service.update_last_used(sandbox_resource_id)
            except Exception:
                logger.warning(f"Failed to update last_used_at for resource {sandbox_resource_id}")
            return sandbox, sandbox_id
        except Exception as e:
            logger.error(f"Error retrieving existing sandbox {sandbox_id}: {str(e)}")
            return None, None
    
    if not files or len(files) == 0:
        logger.debug(f"No files to upload and no sandbox exists for project {project_id}")
        return None, None
    
    try:
        sandbox_pass = str(uuid.uuid4())
        sandbox = await create_sandbox(sandbox_pass, project_id)
        sandbox_id = sandbox.id
        logger.info(f"Created new sandbox {sandbox_id} for project {project_id}")

        vnc_link = await sandbox.get_preview_link(6080)
        website_link = await sandbox.get_preview_link(8080)
        vnc_url = vnc_link.url if hasattr(vnc_link, 'url') else str(vnc_link).split("url='")[1].split("'")[0]
        website_url = website_link.url if hasattr(website_link, 'url') else str(website_link).split("url='")[1].split("'")[0]
        token = None
        if hasattr(vnc_link, 'token'):
            token = vnc_link.token
        elif "token='" in str(vnc_link):
            token = str(vnc_link).split("token='")[1].split("'")[0]

        # Create resource record
        sandbox_config = {
            'pass': sandbox_pass,
            'vnc_preview': vnc_url,
            'sandbox_url': website_url,
            'token': token
        }
        
        try:
            resource = await resource_service.create_resource(
                account_id=account_id,
                resource_type=ResourceType.SANDBOX,
                external_id=sandbox_id,
                config=sandbox_config,
                status=ResourceStatus.ACTIVE
            )
            resource_id = resource['id']
            
            # Link resource to project
            if not await resource_service.link_resource_to_project(project_id, resource_id):
                logger.error(f"Failed to link resource {resource_id} to project {project_id}")
                if sandbox_id:
                    try:
                        await delete_sandbox(sandbox_id)
                        await resource_service.delete_resource(resource_id)
                    except Exception as e:
                        logger.error(f"Error deleting sandbox: {str(e)}")
                raise Exception("Database update failed")
        except Exception as e:
            logger.error(f"Failed to create resource for sandbox {sandbox_id}: {str(e)}")
            if sandbox_id:
                try:
                    await delete_sandbox(sandbox_id)
                except Exception as e:
                    logger.error(f"Error deleting sandbox: {str(e)}")
            raise Exception(f"Failed to create sandbox resource: {str(e)}")
        
        try:
            from core.runtime_cache import set_cached_project_metadata
            sandbox_cache_data = {
                'id': sandbox_id,
                'pass': sandbox_pass,
                'vnc_preview': vnc_url,
                'sandbox_url': website_url,
                'token': token
            }
            await set_cached_project_metadata(project_id, sandbox_cache_data)
            logger.debug(f"✅ Updated project cache with sandbox data: {project_id}")
        except Exception as cache_error:
            logger.warning(f"Failed to update project cache: {cache_error}")
        
        return sandbox, sandbox_id
    except Exception as e:
        logger.error(f"Error creating sandbox: {str(e)}")
        raise Exception(f"Failed to create sandbox: {str(e)}")


async def start_agent_run(
    account_id: str,
    prompt: str,
    agent_id: Optional[str] = None,
    model_name: Optional[str] = None,
    thread_id: Optional[str] = None,
    project_id: Optional[str] = None,
    message_content: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    skip_limits_check: bool = False,
) -> Dict[str, Any]:
    import time
    t_start = time.time()
    
    logger.info(f"[AGENT_FLOW] START_AGENT_RUN: Starting (thread_id: {thread_id}, is_new_thread: {thread_id is None}, account_id: {account_id})")
    
    client = await utils.db.client
    is_new_thread = thread_id is None
    
    final_message_content = message_content or prompt
    
    t_parallel = time.time()
    
    async def load_config():
        logger.debug(f"[AGENT_FLOW] START_AGENT_RUN: Loading agent config")
        # Load config for limits checking (billing checks may need agent info)
        from core.agent_service import _load_agent_config
        return await _load_agent_config(client, agent_id, account_id, account_id, is_new_thread=is_new_thread)
    
    async def check_limits():
        if skip_limits_check:
            logger.debug(f"[AGENT_FLOW] START_AGENT_RUN: Skipping limits check")
            return
        logger.debug(f"[AGENT_FLOW] START_AGENT_RUN: Checking billing and limits")
        await _check_billing_and_limits(
            client, account_id, model_name or "default", 
            check_project_limit=is_new_thread, 
            check_thread_limit=is_new_thread
        )
    
    agent_config, _ = await asyncio.gather(load_config(), check_limits())
    logger.info(f"[AGENT_FLOW] START_AGENT_RUN: Config loaded and limits checked (took {(time.time() - t_parallel) * 1000:.1f}ms)")
    
    if is_new_thread:
        project_created_here = False
        
        if not project_id:
            t_project = time.time()
            project_id = str(uuid.uuid4())
            placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
            
            await client.table('projects').insert({
                "project_id": project_id,
                "account_id": account_id,
                "name": placeholder_name,
                "created_at": datetime.now(timezone.utc).isoformat()
            }).execute()
            project_created_here = True
            logger.debug(f"⏱️ [TIMING] Project created: {(time.time() - t_project) * 1000:.1f}ms")
            
            try:
                from core.runtime_cache import set_cached_project_metadata
                await set_cached_project_metadata(project_id, {})
            except Exception:
                pass
            
            asyncio.create_task(generate_and_update_project_name(project_id=project_id, prompt=prompt))
        
        t_thread = time.time()
        thread_id = str(uuid.uuid4())
        try:
            # Create thread with default name, will be updated by LLM in background
            await client.table('threads').insert({
                "thread_id": thread_id,
                "project_id": project_id,
                "account_id": account_id,
                "name": "New Chat",
                "created_at": datetime.now(timezone.utc).isoformat()
            }).execute()
            logger.debug(f"⏱️ [TIMING] Thread created: {(time.time() - t_thread) * 1000:.1f}ms")
            
            # Generate proper thread name in background using LLM (fire-and-forget)
            if prompt:
                from core.utils.thread_name_generator import generate_and_update_thread_name
                asyncio.create_task(generate_and_update_thread_name(thread_id=thread_id, prompt=prompt))
            
            if project_id and project_id != thread_id:
                try:
                    old_cache_key = f"file_context:{project_id}"
                    new_cache_key = f"file_context:{thread_id}"
                    cached_data = await redis.get(old_cache_key)
                    if cached_data:
                        await redis.set(new_cache_key, cached_data, ex=3600)
                        await redis.delete(old_cache_key)
                        logger.debug(f"Migrated file cache from {project_id} to {thread_id}")
                except Exception as cache_migrate_error:
                    logger.warning(f"Failed to migrate file cache: {cache_migrate_error}")
        except Exception as thread_error:
            if project_created_here:
                logger.warning(f"Thread creation failed, rolling back project {project_id}: {str(thread_error)}")
                try:
                    await client.table('projects').delete().eq('project_id', project_id).execute()
                    logger.debug(f"✅ Rolled back orphan project {project_id}")
                except Exception as rollback_error:
                    logger.error(f"Failed to rollback orphan project {project_id}: {str(rollback_error)}")
            raise thread_error
        
        structlog.contextvars.bind_contextvars(thread_id=thread_id, project_id=project_id, account_id=account_id)
        
        try:
            from core.runtime_cache import increment_thread_count_cache
            asyncio.create_task(increment_thread_count_cache(account_id))
        except Exception:
            pass
    
    t_parallel2 = time.time()
    
    async def create_message():
        if not final_message_content or not final_message_content.strip():
            if is_new_thread:
                logger.warning(f"Attempted to create empty message for new thread - this shouldn't happen (validation should catch this)")
            else:
                logger.debug(f"No prompt provided for existing thread {thread_id} - assuming message already exists")
            return
            
        await client.table('messages').insert({
            "message_id": str(uuid.uuid4()),
            "thread_id": thread_id,
            "type": "user",
            "is_llm_message": True,
            "content": {"role": "user", "content": final_message_content},
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        logger.debug(f"Created user message for thread {thread_id}")
    
    # Create message and start agent run in parallel
    from core.agent_service import start_agent
    
    async def start_agent_run():
        logger.debug(f"[AGENT_FLOW] START_AGENT_RUN: Calling agent_service.start_agent()")
        return await start_agent(
            thread_id=thread_id,
            project_id=project_id,
            account_id=account_id,
            model_name=model_name,
            agent_id=agent_id,
            is_new_thread=is_new_thread,
            extra_metadata=metadata,
        )
    
    logger.info(f"[AGENT_FLOW] START_AGENT_RUN: Creating message and starting agent run in parallel")
    _, agent_run_id = await asyncio.gather(create_message(), start_agent_run())
    logger.info(f"[AGENT_FLOW] START_AGENT_RUN: Message created and agent run started (agent_run_id: {agent_run_id}, took {(time.time() - t_parallel2) * 1000:.1f}ms)")
    
    logger.info(f"[AGENT_FLOW] START_AGENT_RUN COMPLETE: Total time {(time.time() - t_start) * 1000:.1f}ms")
    
    return {
        "thread_id": thread_id,
        "agent_run_id": agent_run_id,
        "project_id": project_id,
        "status": "running"
    }


@router.post("/agent/start", response_model=UnifiedAgentStartResponse, summary="Start Agent (Unified)", operation_id="unified_agent_start")
async def unified_agent_start(
    request: Request,
    thread_id: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    model_name: Optional[str] = Form(None),
    agent_id: Optional[str] = Form(None),
    files: List[UploadFile] = File(default=[]),
    file_ids: List[str] = Form(default=[]),
    optimistic: Optional[str] = Form(None),
    memory_enabled: Optional[str] = Form(None),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    import time
    api_request_start = time.time()
    
    if not utils.instance_id:
        raise HTTPException(status_code=500, detail="Worker API not initialized with instance ID")
    
    client = await utils.db.client
    account_id = user_id
    
    is_optimistic = optimistic and optimistic.lower() == 'true'
    
    logger.info(f"[AGENT_FLOW] API: Received agent start request (optimistic: {is_optimistic}, thread_id: {thread_id}, project_id: {project_id}, user_id: {user_id})")
    logger.debug(f"[AGENT_FLOW] API: Request details - prompt_length: {len(prompt) if prompt else 0}, model_name: {model_name}, agent_id: {agent_id}, files_count: {len(files)}, file_ids_count: {len(file_ids)}")
    
    staged_files_data = None
    if file_ids and len(file_ids) > 0:
        from core.files import get_staged_files_for_thread
        target_thread_id = thread_id or project_id or str(uuid.uuid4())
        staged_files_data = await get_staged_files_for_thread(file_ids, user_id, target_thread_id)
        if staged_files_data:
            logger.info(f"📎 Retrieved {len(staged_files_data)} staged files for agent start")
    
    if is_optimistic:
        logger.info(f"[AGENT_FLOW] API: Processing optimistic start request")
        if not thread_id or not project_id:
            logger.error(f"[AGENT_FLOW] API: Missing required params (thread_id: {thread_id}, project_id: {project_id})")
            raise HTTPException(status_code=400, detail="thread_id and project_id are required for optimistic mode")
        
        if not prompt or not prompt.strip():
            logger.error(f"[AGENT_FLOW] API: Missing prompt for optimistic mode")
            raise HTTPException(status_code=400, detail="prompt is required for optimistic mode")
        
        try:
            logger.debug(f"[AGENT_FLOW] API: Validating UUIDs")
            # Note: uuid module is already imported at module level (line 4)
            # Validate UUID format for thread_id and project_id
            try:
                uuid.UUID(thread_id)
                uuid.UUID(project_id)
            except ValueError:
                logger.error(f"[AGENT_FLOW] API: Invalid UUID format")
                raise HTTPException(status_code=400, detail="Invalid UUID format for thread_id or project_id")
            
            logger.info(f"[AGENT_FLOW] API: Resolving model name")
            resolved_model = model_name
            if resolved_model is None:
                resolved_model = await model_manager.get_default_model_for_user(client, account_id)
                logger.debug(f"[AGENT_FLOW] API: Using default model: {resolved_model}")
            else:
                resolved_model = model_manager.resolve_model_id(resolved_model)
                logger.debug(f"[AGENT_FLOW] API: Resolved provided model: {resolved_model}")
            
            t_billing = time.time()
            logger.info(f"[AGENT_FLOW] API: Checking billing and limits")
            await _check_billing_and_limits(client, account_id, resolved_model, check_project_limit=True, check_thread_limit=True)
            logger.info(f"[AGENT_FLOW] API: Billing check passed (took {(time.time() - t_billing) * 1000:.1f}ms)")
            
            structlog.contextvars.bind_contextvars(thread_id=thread_id, project_id=project_id, account_id=account_id)
            
            from core.thread_init_service import create_thread_optimistically
            
            memory_enabled_bool = None
            if memory_enabled is not None:
                memory_enabled_bool = memory_enabled.lower() == 'true'
            
            logger.info(f"[AGENT_FLOW] API: Calling create_thread_optimistically")
            result = await create_thread_optimistically(
                thread_id=thread_id,
                project_id=project_id,
                account_id=account_id,
                prompt=prompt,
                agent_id=agent_id,
                model_name=resolved_model,
                files=files if len(files) > 0 else None,
                staged_files=staged_files_data,
                memory_enabled=memory_enabled_bool,
            )
            
            logger.info(f"[AGENT_FLOW] API: Optimistic start complete (thread_id: {result['thread_id']}, total time: {(time.time() - api_request_start) * 1000:.1f}ms)")
            
            return {
                "thread_id": result["thread_id"],
                "project_id": result["project_id"],
                "agent_run_id": None,
                "status": "pending"
            }
        
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error in optimistic agent start: {str(e)}\n{traceback.format_exc()}")
            error_details = {
                "error": str(e),
                "error_type": type(e).__name__,
                "traceback": traceback.format_exc()
            }
            logger.error(f"Full error details: {error_details}")
            raise HTTPException(status_code=500, detail=f"Failed to start agent: {str(e)}")
    
    
    if not thread_id and (not prompt or not prompt.strip()):
        raise HTTPException(status_code=400, detail="prompt is required when creating a new thread")
    
    if model_name is None:
        model_name = await model_manager.get_default_model_for_user(client, account_id)
    elif model_name == "mock-ai":
        pass
    else:
        model_name = model_manager.resolve_model_id(model_name)
    
    try:
        project_id = None
        message_content = prompt or ""
        
        if thread_id:
            structlog.contextvars.bind_contextvars(thread_id=thread_id)
            
            thread_result = await client.table('threads').select('project_id, account_id').eq('thread_id', thread_id).execute()
            if not thread_result.data:
                raise HTTPException(status_code=404, detail="Thread not found")
            
            thread_data = thread_result.data[0]
            project_id = thread_data['project_id']
            
            if thread_data['account_id'] != user_id:
                await verify_and_authorize_thread_access(client, thread_id, user_id)
            
            structlog.contextvars.bind_contextvars(project_id=project_id, account_id=account_id)
            
            image_contexts_to_inject = []
            
            if staged_files_data and len(staged_files_data) > 0:
                try:
                    message_content, image_contexts_to_inject = await _handle_staged_files_for_thread(
                        staged_files=staged_files_data,
                        thread_id=thread_id,
                        project_id=project_id,
                        prompt=prompt or "",
                        account_id=account_id
                    )
                    logger.info(f"Processed {len(staged_files_data)} staged files for existing thread {thread_id}")
                except Exception as e:
                    logger.error(f"Failed to process staged files for existing thread: {e}")
                    raise HTTPException(status_code=500, detail=f"Failed to process staged files: {str(e)}")
            elif files and len(files) > 0:
                try:
                    message_content = await _handle_file_uploads_fast(files, project_id, prompt or "", thread_id)
                    logger.info(f"Fast-parsed {len(files)} files for existing thread {thread_id}, sandbox upload in background")
                except Exception as e:
                    logger.error(f"Failed to fast-parse files for existing thread: {e}")
                    raise HTTPException(status_code=500, detail=f"Failed to process files: {str(e)}")
            
            for img_info in image_contexts_to_inject:
                try:
                    image_message = {
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
                        "content": image_message,
                        "metadata": {"file_path": img_info['filename'], "mime_type": img_info['mime_type'], "source": "user_upload"},
                        "created_at": datetime.now(timezone.utc).isoformat()
                    }).execute()
                    logger.info(f"📷 Injected image context for {img_info['filename']} into thread {thread_id}")
                except Exception as img_err:
                    logger.warning(f"Failed to inject image context: {img_err}")
        
        else:
            new_thread_image_contexts = []
            has_files = (files and len(files) > 0) or (staged_files_data and len(staged_files_data) > 0)
            
            if has_files:
                project_id = str(uuid.uuid4())
                placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
                await client.table('projects').insert({
                    "project_id": project_id,
                    "account_id": account_id,
                    "name": placeholder_name,
                    "created_at": datetime.now(timezone.utc).isoformat()
                }).execute()
                
                try:
                    from core.runtime_cache import set_cached_project_metadata
                    await set_cached_project_metadata(project_id, {})
                except Exception:
                    pass
                asyncio.create_task(generate_and_update_project_name(project_id=project_id, prompt=prompt))
                
                temp_thread_id = str(uuid.uuid4())
                
                if staged_files_data and len(staged_files_data) > 0:
                    try:
                        message_content, new_thread_image_contexts = await _handle_staged_files_for_thread(
                            staged_files=staged_files_data,
                            thread_id=temp_thread_id,
                            project_id=project_id,
                            prompt=prompt,
                            account_id=account_id
                        )
                        logger.info(f"Processed {len(staged_files_data)} staged files for new thread")
                    except Exception as e:
                        await client.table('projects').delete().eq('project_id', project_id).execute()
                        raise HTTPException(status_code=500, detail=f"Failed to process staged files: {str(e)}")
                elif files and len(files) > 0:
                    try:
                        message_content = await _handle_file_uploads_fast(files, project_id, prompt)
                        logger.info(f"Fast-parsed {len(files)} files for new thread, sandbox upload in background")
                    except Exception as e:
                        await client.table('projects').delete().eq('project_id', project_id).execute()
                        raise HTTPException(status_code=500, detail=f"Failed to process files: {str(e)}")
        
        result = await start_agent_run(
            account_id=account_id,
            prompt=prompt or "",
            agent_id=agent_id,
            model_name=model_name,
            thread_id=thread_id,
            project_id=project_id,
            message_content=message_content,
        )
        
        logger.info(f"⏱️ [TIMING] 🎯 API Request Total: {(time.time() - api_request_start) * 1000:.1f}ms")
        
        return {"thread_id": result["thread_id"], "agent_run_id": result["agent_run_id"], "status": "running"}
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in unified agent start: {str(e)}\n{traceback.format_exc()}")
        error_details = {
            "error": str(e),
            "error_type": type(e).__name__,
            "traceback": traceback.format_exc()
        }
        logger.error(f"Full error details: {error_details}")
        raise HTTPException(status_code=500, detail=f"Failed to start agent: {str(e)}")

@router.post("/thread/{thread_id}/start-agent", summary="Start Agent on Initialized Thread", operation_id="start_agent_on_thread")
async def start_agent_on_thread(
    thread_id: str,
    model_name: Optional[str] = None,
    agent_id: Optional[str] = None,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    import time
    api_request_start = time.time()
    
    if not utils.instance_id:
        raise HTTPException(status_code=500, detail="Worker API not initialized with instance ID")
    
    client = await utils.db.client
    account_id = user_id
    
    try:
        thread_result = await client.table('threads').select('project_id, account_id, status').eq('thread_id', thread_id).execute()
        if not thread_result.data:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        thread_data = thread_result.data[0]
        project_id = thread_data['project_id']
        thread_status = thread_data.get('status', 'ready')
        
        if thread_data['account_id'] != user_id:
            await verify_and_authorize_thread_access(client, thread_id, user_id)
        
        if thread_status == 'error':
            raise HTTPException(status_code=400, detail="Thread initialization failed, cannot start agent")
        
        if thread_status in ['pending', 'initializing']:
            raise HTTPException(status_code=409, detail=f"Thread is still {thread_status}, please wait for initialization to complete")
        
        structlog.contextvars.bind_contextvars(thread_id=thread_id, project_id=project_id, account_id=account_id)
        
        if model_name is None:
            model_name = await model_manager.get_default_model_for_user(client, account_id)
        elif model_name == "mock-ai":
            pass
        else:
            model_name = model_manager.resolve_model_id(model_name)
        
        result = await start_agent_run(
            account_id=account_id,
            prompt="",
            agent_id=agent_id,
            model_name=model_name,
            thread_id=thread_id,
            project_id=project_id,
            message_content=None,
        )
        
        await client.table('threads').update({
            "status": "ready",
        }).eq('thread_id', thread_id).execute()
        
        logger.info(f"⏱️ [TIMING] 🎯 Start Agent on Thread Total: {(time.time() - api_request_start) * 1000:.1f}ms")
        
        return {"thread_id": result["thread_id"], "agent_run_id": result["agent_run_id"], "status": "running"}
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting agent on thread: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to start agent: {str(e)}")

@router.post("/agent-run/{agent_run_id}/stop", summary="Stop Agent Run", operation_id="stop_agent_run")
async def stop_agent(agent_run_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
    )
    logger.debug(f"Received request to stop agent run: {agent_run_id}")
    client = await utils.db.client
    await _get_agent_run_with_access_check(client, agent_run_id, user_id)
    await stop_agent_run(agent_run_id)
    return {"status": "stopped"}

@router.get("/agent-runs/active", summary="List All Active Agent Runs", operation_id="list_active_agent_runs")
async def get_active_agent_runs(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    try:
        logger.debug(f"Fetching all active agent runs for user: {user_id}")
        client = await utils.db.client
        
        try:
            user_threads = await client.table('threads').select('thread_id').eq('account_id', user_id).execute()
        except Exception as db_error:
            logger.error(f"Database error fetching threads for user {user_id}: {str(db_error)}")
            return {"active_runs": []}
        
        if not user_threads.data:
            return {"active_runs": []}
        
        thread_ids = [
            str(thread['thread_id']) 
            for thread in user_threads.data 
            if thread.get('thread_id') and str(thread['thread_id']).strip()
        ]
        
        logger.debug(f"Found {len(thread_ids)} valid thread_ids for user {user_id} (from {len(user_threads.data)} total threads)")
        
        if not thread_ids:
            logger.debug(f"No valid thread_ids found for user: {user_id}")
            return {"active_runs": []}
        
        from core.utils.query_utils import batch_query_in
        
        try:
            agent_runs_data = await batch_query_in(
                client=client,
                table_name='agent_runs',
                select_fields='id, thread_id, status, started_at',
                in_field='thread_id',
                in_values=thread_ids,
                additional_filters={'status': 'running'}
            )
        except Exception as query_error:
            logger.error(f"Query error fetching agent runs for user {user_id}: {str(query_error)}")
            return {"active_runs": []}
        
        if not agent_runs_data:
            return {"active_runs": []}
        
        accessible_runs = [
            {
                'id': run.get('id'),
                'thread_id': run.get('thread_id'),
                'status': run.get('status'),
                'started_at': run.get('started_at')
            }
            for run in agent_runs_data
            if run and run.get('id')
        ]
        
        logger.debug(f"Found {len(accessible_runs)} active agent runs for user: {user_id}")
        
        return {"active_runs": accessible_runs}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching active agent runs for user {user_id}: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch active agent runs: {str(e)}")

@router.get("/thread/{thread_id}/agent-runs", summary="List Thread Agent Runs", operation_id="list_thread_agent_runs")
async def get_agent_runs(thread_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
    )
    logger.debug(f"Fetching agent runs for thread: {thread_id}")
    client = await utils.db.client
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    agent_runs = await client.table('agent_runs').select('id, thread_id, status, started_at, completed_at, error, created_at, updated_at').eq("thread_id", thread_id).order('created_at', desc=True).execute()
    logger.debug(f"Found {len(agent_runs.data)} agent runs for thread: {thread_id}")
    return {"agent_runs": agent_runs.data}

@router.get("/agent-run/{agent_run_id}", summary="Get Agent Run", operation_id="get_agent_run")
async def get_agent_run(agent_run_id: str, user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
    )
    logger.debug(f"Fetching agent run details: {agent_run_id}")
    client = await utils.db.client
    agent_run_data = await _get_agent_run_with_access_check(client, agent_run_id, user_id)
    return {
        "id": agent_run_data['id'],
        "threadId": agent_run_data['thread_id'],
        "status": agent_run_data['status'],
        "startedAt": agent_run_data['started_at'],
        "completedAt": agent_run_data['completed_at'],
        "error": agent_run_data['error']
    }

@router.get("/agent-run/{agent_run_id}/stream", summary="Stream Agent Run", operation_id="stream_agent_run")
async def stream_agent_run(
    agent_run_id: str,
    token: Optional[str] = None,
    request: Request = None
):
    logger.debug(f"🔐 Stream auth check - agent_run: {agent_run_id}, has_token: {bool(token)}")
    client = await utils.db.client

    user_id = await get_user_id_from_stream_auth(request, token)
    agent_run_data = await _get_agent_run_with_access_check(client, agent_run_id, user_id)

    structlog.contextvars.bind_contextvars(
        agent_run_id=agent_run_id,
        user_id=user_id,
    )

    stream_key = f"agent_run:{agent_run_id}:stream"

    def find_last_safe_boundary(entries):
        """Find the last safe boundary for trimming stream entries.
        
        Structure-aware: Only trims at COMPLETE response boundaries.
        A safe boundary is defined as:
        1. `llm_response_end` - marks the complete end of an LLM response cycle
        2. Final status messages (completed, failed, stopped, error) - marks agent run end
        
        NOTE: We do NOT treat individual assistant messages with stream_status='complete'
        as safe boundaries because with multiple tool calls in a single response,
        the assistant message completes before all tool executions finish.
        Only `llm_response_end` signals that the ENTIRE response (including all tool calls)
        has been processed.
        """
        last_safe_index = -1
        
        # Track response boundaries to ensure we only trim complete cycles
        # Each llm_response_start must have a matching llm_response_end
        open_responses = 0  # Count of llm_response_start without matching llm_response_end
        last_complete_response_end_index = -1
        
        for i, (entry_id, fields) in enumerate(entries):
            try:
                data = json.loads(fields.get('data', '{}'))
                msg_type = data.get('type')
                
                if msg_type == 'llm_response_start':
                    open_responses += 1
                    logger.debug(f"Found llm_response_start at index {i}, open_responses={open_responses}")
                
                elif msg_type == 'llm_response_end':
                    open_responses = max(0, open_responses - 1)
                    if open_responses == 0:
                        # This llm_response_end closes a complete response cycle
                        last_complete_response_end_index = i
                        last_safe_index = i
                        logger.debug(f"Found safe boundary at index {i}: llm_response_end (complete cycle)")
                    else:
                        logger.debug(f"Found llm_response_end at index {i}, but {open_responses} responses still open")
                
                elif msg_type == 'status':
                    status = data.get('status')
                    if status in ['completed', 'failed', 'stopped', 'error']:
                        # Final status - safe to trim up to here
                        last_safe_index = i
                        logger.debug(f"Found safe boundary at index {i}: status={status}")
                
                # NOTE: We intentionally do NOT treat assistant stream_status='complete' as safe
                # because with multiple tool calls, the assistant message completes but tools
                # may still be executing. Only llm_response_end signals full completion.
                
            except (json.JSONDecodeError, KeyError, TypeError) as e:
                logger.debug(f"Skipping malformed entry at index {i}: {e}")
                continue
        
        # Safety check: if there are still open responses, don't trim
        if open_responses > 0 and last_safe_index == last_complete_response_end_index:
            logger.debug(f"Still have {open_responses} open responses - skipping trim for safety")
            return -1
        
        return last_safe_index

    async def stream_generator(agent_run_data):
        logger.info(f"[AGENT_FLOW] STREAM: Starting stream generator (agent_run_id: {agent_run_id}, stream_key: {stream_key})")
        terminate_stream = False
        initial_yield_complete = False
        last_id = "0"  # Start from beginning for initial read

        try:
            # Send immediate "connected" message so frontend knows connection is established
            logger.info(f"[AGENT_FLOW] STREAM STEP 1: Sending 'connected' message")
            yield f"data: {json.dumps({'type': 'connected', 'agent_run_id': agent_run_id})}\n\n"
            logger.debug(f"[AGENT_FLOW] STREAM STEP 1: 'connected' message sent")
            
            logger.info(f"[AGENT_FLOW] STREAM STEP 2: Reading initial entries from stream {stream_key}")
            initial_entries = await redis.stream_range(stream_key)
            logger.info(f"[AGENT_FLOW] STREAM STEP 2: Found {len(initial_entries) if initial_entries else 0} initial entries in stream {stream_key}")
            
            # Verify stream exists and check its length
            try:
                stream_len = await redis.stream_len(stream_key)
                logger.info(f"[AGENT_FLOW] STREAM STEP 2: Stream {stream_key} length: {stream_len}")
            except Exception as e:
                logger.warning(f"[AGENT_FLOW] STREAM STEP 2: Could not check stream length: {e}")
            
            # Early check: Verify Temporal workflow exists and is running
            workflow_exists = False
            if not initial_entries:
                try:
                    from core.temporal.client import get_temporal_client
                    temporal_client = await get_temporal_client()
                    workflow_id = f"agent-run-{agent_run_id}"
                    logger.debug(f"[AGENT_FLOW] STREAM STEP 2.1: Verifying Temporal workflow exists (workflow_id: {workflow_id})")
                    
                    try:
                        handle = temporal_client.get_workflow_handle(workflow_id)
                        workflow_status = await handle.describe()
                        workflow_exists = True
                        status_name = workflow_status.status.name if hasattr(workflow_status.status, 'name') else str(workflow_status.status)
                        logger.info(f"[AGENT_FLOW] STREAM STEP 2.1: Temporal workflow found - status: {status_name}")
                        
                        # If workflow is already completed/failed, check DB and exit early
                        if status_name in ['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED']:
                            logger.warning(f"[AGENT_FLOW] STREAM STEP 2.1: Workflow already finished with status: {status_name}")
                            # Check DB for final status
                            run_check = await client.table('agent_runs').select('status, error').eq('id', agent_run_id).maybe_single().execute()
                            db_status = run_check.data.get('status') if run_check.data else 'unknown'
                            db_error = run_check.data.get('error') if run_check.data else None
                            
                            if db_status in ['completed', 'failed', 'stopped']:
                                yield f"data: {json.dumps({'type': 'status', 'status': db_status, 'error': db_error})}\n\n"
                                terminate_stream = True
                                return
                    except Exception as workflow_check_error:
                        error_str = str(workflow_check_error)
                        logger.warning(f"[AGENT_FLOW] STREAM STEP 2.1: Temporal workflow not found or error: {error_str}")
                        # If workflow doesn't exist and DB shows running, this is a problem
                        if 'not found' in error_str.lower() or 'does not exist' in error_str.lower():
                            run_check = await client.table('agent_runs').select('status').eq('id', agent_run_id).maybe_single().execute()
                            db_status = run_check.data.get('status') if run_check.data else None
                            if db_status == 'running':
                                logger.error(f"[AGENT_FLOW] STREAM STEP 2.1: CRITICAL - Workflow {workflow_id} does not exist but DB shows running!")
                                await client.table('agent_runs').update({
                                    'status': 'failed',
                                    'error': 'Temporal workflow was never started or was lost',
                                    'completed_at': datetime.now(timezone.utc).isoformat()
                                }).eq('id', agent_run_id).execute()
                                yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': 'Agent workflow was not started properly. Please try again.'})}\n\n"
                                terminate_stream = True
                                return
                except Exception as temporal_err:
                    logger.debug(f"[AGENT_FLOW] STREAM STEP 2.1: Could not check Temporal workflow (non-critical): {temporal_err}")
            if initial_entries:
                logger.debug(f"Sending {len(initial_entries)} catch-up responses for {agent_run_id}")
                for entry_id, fields in initial_entries:
                    response = json.loads(fields.get('data', '{}'))
                    yield f"data: {json.dumps(response)}\n\n"
                    last_id = entry_id
                    if response.get('type') == 'status' and response.get('status') in ['completed', 'failed', 'stopped', 'error']:
                        logger.debug(f"Detected completion in catch-up: {response.get('status')}")
                        terminate_stream = True
                        return
                
                if last_id != "0":
                    try:
                        last_safe_index = find_last_safe_boundary(initial_entries)
                        
                        if last_safe_index >= 0:
                            safe_boundary_entry_id = initial_entries[last_safe_index][0]
                            
                            if '-' in safe_boundary_entry_id:
                                parts = safe_boundary_entry_id.split('-')
                                if len(parts) == 2:
                                    try:
                                        timestamp = parts[0]
                                        sequence = int(parts[1])
                                        next_id = f"{timestamp}-{sequence + 1}"
                                        trimmed_count = await redis.xtrim_minid(stream_key, next_id, approximate=True)
                                        logger.debug(f"Trimmed {trimmed_count} entries from stream {stream_key} up to safe boundary at index {last_safe_index} (entry: {safe_boundary_entry_id})")
                                    except (ValueError, IndexError):
                                        trimmed_count = await redis.xtrim_minid(stream_key, safe_boundary_entry_id, approximate=True)
                                        logger.debug(f"Trimmed {trimmed_count} entries from stream {stream_key} up to safe boundary (fallback)")
                                else:
                                    trimmed_count = await redis.xtrim_minid(stream_key, safe_boundary_entry_id, approximate=True)
                                    logger.debug(f"Trimmed {trimmed_count} entries from stream {stream_key} up to safe boundary")
                            else:
                                trimmed_count = await redis.xtrim_minid(stream_key, safe_boundary_entry_id, approximate=True)
                                logger.debug(f"Trimmed {trimmed_count} entries from stream {stream_key} up to safe boundary")
                        else:
                            logger.debug(f"No safe boundary found in {len(initial_entries)} entries - skipping trim to prevent race conditions")
                    except Exception as trim_error:
                        logger.warning(f"Failed to trim stream after catch-up read: {trim_error}")
            
            initial_yield_complete = True

            if terminate_stream:
                return

            current_status = agent_run_data.get('status') if agent_run_data else None
            if current_status != 'running':
                logger.debug(f"Agent run {agent_run_id} is not running (status: {current_status}). Ending stream.")
                yield f"data: {json.dumps({'type': 'status', 'status': 'completed'})}\n\n"
                return

            structlog.contextvars.bind_contextvars(
                thread_id=agent_run_data.get('thread_id'),
            )

            # Startup timeout: if no real data received after N pings, check if worker is stuck
            consecutive_pings = 0
            received_real_data = len(initial_entries) > 0 if initial_entries else False
            MAX_STARTUP_PINGS = 6  # 6 pings * 5 seconds = 30 second startup timeout (reduced for faster feedback)
            
            # Send "waiting" status if workflow exists but no data yet
            if not received_real_data and workflow_exists:
                logger.info(f"[AGENT_FLOW] STREAM STEP 2.2: Workflow exists but no data yet - sending waiting status")
                yield f"data: {json.dumps({'type': 'status', 'status': 'waiting', 'message': 'Waiting for worker to start processing...'})}\n\n"
            
            # Re-check stream right before starting blocking reads to catch any entries written
            # between the initial check and now (race condition protection)
            if not received_real_data:
                logger.info(f"[AGENT_FLOW] STREAM STEP 2.3: Re-checking stream {stream_key} for entries written since initial check")
                recheck_entries = await redis.stream_range(stream_key)
                logger.info(f"[AGENT_FLOW] STREAM STEP 2.3: Recheck found {len(recheck_entries) if recheck_entries else 0} entries")
                if recheck_entries:
                    logger.info(f"[AGENT_FLOW] STREAM STEP 2.3: Found {len(recheck_entries)} entries on recheck - processing catch-up")
                    for entry_id, fields in recheck_entries:
                        response = json.loads(fields.get('data', '{}'))
                        yield f"data: {json.dumps(response)}\n\n"
                        last_id = entry_id
                        received_real_data = True
                        if response.get('type') == 'status' and response.get('status') in ['completed', 'failed', 'stopped', 'error']:
                            logger.debug(f"Detected completion in recheck catch-up: {response.get('status')}")
                            terminate_stream = True
                            return
            
            # Use blocking XREAD to wait for new stream entries
            # After catch-up, only read new entries
            if last_id == "0":
                # No entries seen yet - use "$" to only read NEW entries that arrive after we start listening
                last_id = "$"
                logger.debug(f"[AGENT_FLOW] STREAM: No entries seen yet, using '$' to read only new entries")
            else:
                # We have a last entry ID - use it directly to read entries newer than that ID
                # Don't change last_id - it already points to the last entry we saw
                logger.debug(f"[AGENT_FLOW] STREAM: Using last_id '{last_id}' to read entries newer than last seen")
            
            while not terminate_stream:
                try:
                    # Blocking XREAD - waits up to 5 seconds for new entries
                    # Wrap with asyncio.wait_for to prevent infinite hangs if Redis connection issues occur
                    try:
                        entries = await asyncio.wait_for(
                            redis.stream_read(stream_key, last_id, block_ms=5000),
                            timeout=10.0  # Safety timeout - ensures we never hang indefinitely
                        )
                    except asyncio.TimeoutError:
                        logger.warning(f"[AGENT_FLOW] STREAM: Redis stream_read timed out after 10s (safety timeout)")
                        entries = []  # Treat as empty, will trigger ping
                    
                    if entries:
                        logger.info(f"[AGENT_FLOW] STREAM: ✅ Read {len(entries)} entries from stream {stream_key}")
                        received_real_data = True
                        consecutive_pings = 0  # Reset ping counter on real data
                        for entry_id, fields in entries:
                            data = fields.get('data', '{}')
                            yield f"data: {data}\n\n"
                            last_id = entry_id
                            logger.debug(f"[AGENT_FLOW] STREAM: Processed entry {entry_id} from stream")
                            
                            # Check for completion status
                            try:
                                response = json.loads(data)
                                if response.get('type') == 'status' and response.get('status') in ['completed', 'failed', 'stopped', 'error']:
                                    logger.debug(f"Detected completion via stream: {response.get('status')}")
                                    terminate_stream = True
                                    break
                            except json.JSONDecodeError:
                                pass
                    else:
                        consecutive_pings += 1
                        
                        # Periodic workflow status check: every 15 seconds (every 3 pings)
                        if not received_real_data and consecutive_pings > 0 and consecutive_pings % 3 == 0:
                            try:
                                from core.temporal.client import get_temporal_client
                                temporal_client = await get_temporal_client()
                                workflow_id = f"agent-run-{agent_run_id}"
                                logger.debug(f"[AGENT_FLOW] STREAM: Periodic workflow check (ping {consecutive_pings}, workflow_id: {workflow_id})")
                                
                                try:
                                    handle = temporal_client.get_workflow_handle(workflow_id)
                                    workflow_status = await handle.describe()
                                    status_name = workflow_status.status.name if hasattr(workflow_status.status, 'name') else str(workflow_status.status)
                                    logger.info(f"[AGENT_FLOW] STREAM: Periodic check - workflow status: {status_name}")
                                    
                                    # If workflow is completed/failed but we haven't received data, check DB
                                    if status_name in ['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED']:
                                        run_check = await client.table('agent_runs').select('status, error').eq('id', agent_run_id).maybe_single().execute()
                                        db_status = run_check.data.get('status') if run_check.data else 'unknown'
                                        db_error = run_check.data.get('error') if run_check.data else None
                                        
                                        if db_status in ['completed', 'failed', 'stopped']:
                                            logger.warning(f"[AGENT_FLOW] STREAM: Workflow finished ({status_name}) but no stream data - sending DB status")
                                            yield f"data: {json.dumps({'type': 'status', 'status': db_status, 'error': db_error})}\n\n"
                                            terminate_stream = True
                                            break
                                except Exception as workflow_check_error:
                                    error_str = str(workflow_check_error)
                                    logger.debug(f"[AGENT_FLOW] STREAM: Periodic check - workflow error: {error_str}")
                                    # Don't terminate on periodic check errors - wait for full timeout
                            except Exception as temporal_err:
                                logger.debug(f"[AGENT_FLOW] STREAM: Periodic check - Temporal client error: {temporal_err}")
                                # Don't terminate on periodic check errors - wait for full timeout
                        
                        # Startup timeout check: if we haven't received any real data and hit the limit
                        if not received_real_data and consecutive_pings >= MAX_STARTUP_PINGS:
                            logger.warning(f"[AGENT_FLOW] STREAM TIMEOUT: Agent run {agent_run_id} - no data received after {consecutive_pings * 5}s")
                            # Check DB status to see if run is still supposed to be running
                            try:
                                run_check = await client.table('agent_runs').select('status').eq('id', agent_run_id).maybe_single().execute()
                                db_status = run_check.data.get('status') if run_check.data else None
                                logger.debug(f"[AGENT_FLOW] STREAM TIMEOUT: DB status for {agent_run_id}: {db_status}")
                                
                                # Also check Temporal workflow status
                                workflow_status = None
                                workflow_error = None
                                try:
                                    from core.temporal.client import get_temporal_client
                                    temporal_client = await get_temporal_client()
                                    workflow_id = f"agent-run-{agent_run_id}"
                                    logger.debug(f"[AGENT_FLOW] STREAM TIMEOUT: Checking Temporal workflow status (workflow_id: {workflow_id})")
                                    
                                    try:
                                        handle = temporal_client.get_workflow_handle(workflow_id)
                                        workflow_status = await handle.describe()
                                        logger.info(f"[AGENT_FLOW] STREAM TIMEOUT: Temporal workflow status: {workflow_status.status.name if hasattr(workflow_status.status, 'name') else workflow_status.status}")
                                    except Exception as workflow_check_error:
                                        workflow_error = str(workflow_check_error)
                                        logger.warning(f"[AGENT_FLOW] STREAM TIMEOUT: Failed to check Temporal workflow: {workflow_error}")
                                except Exception as temporal_err:
                                    logger.warning(f"[AGENT_FLOW] STREAM TIMEOUT: Failed to get Temporal client: {temporal_err}")
                                
                                if db_status == 'running':
                                    # Worker never started or workflow not running
                                    error_msg = 'Worker failed to start within timeout period'
                                    if workflow_error:
                                        error_msg += f' (Temporal check failed: {workflow_error})'
                                    elif workflow_status:
                                        error_msg += f' (Temporal workflow status: {workflow_status.status})'
                                    
                                    logger.error(f"[AGENT_FLOW] STREAM TIMEOUT: Agent run {agent_run_id} stuck - {error_msg}")
                                    await client.table('agent_runs').update({
                                        'status': 'failed',
                                        'error': error_msg,
                                        'completed_at': datetime.now(timezone.utc).isoformat()
                                    }).eq('id', agent_run_id).execute()
                                    yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': 'Agent worker failed to start. Please try again.'})}\n\n"
                                    terminate_stream = True
                                    break
                                elif db_status in ['completed', 'failed', 'stopped']:
                                    logger.debug(f"[AGENT_FLOW] STREAM TIMEOUT: Agent run {agent_run_id} already finished with status: {db_status}")
                                    yield f"data: {json.dumps({'type': 'status', 'status': db_status})}\n\n"
                                    terminate_stream = True
                                    break
                                else:
                                    # Unexpected status (None, 'pending', or unknown) - terminate with error
                                    logger.error(f"[AGENT_FLOW] STREAM TIMEOUT: Agent run {agent_run_id} has unexpected status: {db_status}")
                                    yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': f'Agent run has unexpected status: {db_status}'})}\n\n"
                                    terminate_stream = True
                                    break
                            except Exception as db_err:
                                logger.warning(f"[AGENT_FLOW] STREAM TIMEOUT: Failed to check agent_run status: {db_err}")
                                # Even if DB check fails, terminate after timeout to prevent infinite pings
                                yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': 'Agent worker failed to start (status check failed). Please try again.'})}\n\n"
                                terminate_stream = True
                                break
                        
                        # Not timed out yet - send ping to keep connection alive
                        yield f"data: {json.dumps({'type': 'ping'})}\n\n"

                except asyncio.CancelledError:
                    logger.debug(f"Stream generator cancelled for {agent_run_id}")
                    terminate_stream = True
                    break
                except Exception as e:
                    logger.error(f"Error processing message for {agent_run_id}: {e}", exc_info=True)
                    yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': f'Stream failed: {e}'})}\n\n"
                    terminate_stream = True
                    break

        except Exception as e:
            logger.error(f"Error setting up stream for agent run {agent_run_id}: {e}", exc_info=True)
            if not initial_yield_complete:
                yield f"data: {json.dumps({'type': 'status', 'status': 'error', 'message': f'Failed to start stream: {e}'})}\n\n"

        finally:
            terminate_stream = True
            # No cleanup needed - streams don't hold connections

            logger.debug(f"Streaming cleanup complete for agent run: {agent_run_id}")

    return StreamingResponse(stream_generator(agent_run_data), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive",
        "X-Accel-Buffering": "no", "Content-Type": "text/event-stream",
        "Access-Control-Allow-Origin": "*"
    })
