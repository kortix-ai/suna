"""
File upload handling for agent runs.

Extracted from runs.py - handles file parsing, caching, and sandbox uploads.
"""

import asyncio
import json
import re
import uuid
from typing import Optional, List, Tuple, Dict, Any

from fastapi import UploadFile

from core.services import redis
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.sandbox_utils import generate_unique_filename, get_uploads_directory
from core.sandbox.sandbox import create_sandbox, delete_sandbox, get_or_start_sandbox

db = DBConnection()


async def fast_parse_files(files: List[UploadFile], prompt: str = "") -> Tuple[str, List[Tuple[str, bytes, str, Optional[str]]]]:
    """
    Fast-parse uploaded files and extract content.
    
    Returns:
        Tuple of (updated message content with file refs, list of file data tuples)
        Each file tuple: (filename, content_bytes, mime_type, parsed_content)
    """
    from core.utils.fast_parse import parse, FileType, format_file_size
    
    if not files:
        return prompt, []
    
    message_content = prompt
    files_for_upload: List[Tuple[str, bytes, str, Optional[str]]] = []
    file_refs = []
    
    # Extract existing file references from prompt to avoid duplicates
    existing_refs = set()
    if prompt:
        existing_matches = re.findall(r'\[(?:Uploaded File|Attached|Image):\s*([^\]]+)\]', prompt)
        for match in existing_matches:
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


async def upload_files_to_sandbox_background(
    project_id: str,
    thread_id: str,
    files_data: List[Tuple[str, bytes, str, Optional[str]]],
):
    """Upload files to sandbox in background (fire-and-forget)."""
    if not files_data:
        return
    
    logger.info(f"🔄 Background sandbox upload starting for project {project_id} ({len(files_data)} files)")
    
    try:
        client = await db.client
        
        sandbox, sandbox_id = await ensure_sandbox_for_thread(client, project_id, files_data)
        
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


async def upload_staged_files_to_sandbox_background(
    project_id: str,
    thread_id: str,
    staged_files: List[Dict[str, Any]],
    account_id: str,
):
    """Upload staged files to sandbox in background."""
    if not staged_files:
        return
    
    logger.info(f"🔄 Background staged files -> sandbox upload starting for project {project_id} ({len(staged_files)} files)")
    
    try:
        from core.files import get_staged_file_content
        
        client = await db.client
        
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
        
        sandbox, sandbox_id = await ensure_sandbox_for_thread(client, project_id, files_data)
        
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
    """Get cached file context for a thread from Redis."""
    try:
        cache_key = f"file_context:{thread_id}"
        cached = await redis.get(cache_key)
        if cached:
            return json.loads(cached)
    except Exception as e:
        logger.warning(f"Failed to retrieve cached file context for {thread_id}: {e}")
    return None


def format_file_context_for_agent(files: List[Dict[str, Any]]) -> str:
    """Format cached file context for inclusion in agent prompt."""
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


async def handle_file_uploads_fast(
    files: List[UploadFile],
    project_id: str,
    prompt: str = "",
    thread_id: Optional[str] = None,
) -> str:
    """
    Handle file uploads with fast parsing.
    
    Returns updated message content with file references.
    Schedules background sandbox upload.
    """
    message_content, files_data = await fast_parse_files(files, prompt)
    
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
            asyncio.create_task(upload_files_to_sandbox_background(project_id, tid, files_data))
            logger.debug(f"Scheduled background sandbox upload for {len(files_data)} files")
    
    return message_content


async def handle_staged_files_for_thread(
    staged_files: List[Dict[str, Any]],
    thread_id: str,
    project_id: str,
    prompt: str,
    account_id: str,
) -> Tuple[str, List[Dict[str, Any]]]:
    """
    Handle staged files for a thread.
    
    Returns:
        Tuple of (updated message content, list of image contexts to inject)
    """
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
        
        # Use consistent [Uploaded File: ...] format that frontend expects
        file_refs.append(f"[Uploaded File: uploads/{filename}]")
        
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
    
    asyncio.create_task(upload_staged_files_to_sandbox_background(
        project_id=project_id,
        thread_id=thread_id,
        staged_files=staged_files,
        account_id=account_id
    ))
    logger.debug(f"Scheduled background sandbox upload for {len(staged_files)} staged files")
    
    return message_content, image_contexts


async def ensure_sandbox_for_thread(client, project_id: str, files: Optional[List[Any]] = None):
    """
    Ensure a sandbox exists for the thread, creating one if needed.
    
    Returns:
        Tuple of (sandbox, sandbox_id) or (None, None) if not available
    """
    from core.resources import ResourceService, ResourceType, ResourceStatus
    from core.threads import repo as threads_repo
    
    project_data = await threads_repo.get_project_for_sandbox(project_id)
    
    if not project_data:
        logger.warning(f"Project {project_id} not found when checking for sandbox")
        return None, None
    
    account_id = str(project_data.get('account_id')) if project_data.get('account_id') else None
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
            from core.cache.runtime_cache import set_cached_project_metadata
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

