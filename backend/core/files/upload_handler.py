import json
import re
from typing import Optional, List, Tuple, Dict, Any

from fastapi import UploadFile

from core.services import redis
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.sandbox_utils import generate_unique_filename, get_uploads_directory
from core.sandbox.resolver import resolve_sandbox

db = DBConnection()


async def fast_parse_files(files: List[UploadFile], prompt: str = "") -> Tuple[str, List[Tuple[str, bytes, str, Optional[str]]]]:
    from core.utils.fast_parse import parse, FileType, format_file_size
    
    if not files:
        return prompt, []
    
    message_content = prompt
    files_for_upload: List[Tuple[str, bytes, str, Optional[str]]] = []
    file_refs = []
    
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


async def upload_files_to_sandbox(
    project_id: str,
    thread_id: str,
    files_data: List[Tuple[str, bytes, str, Optional[str]]],
    account_id: Optional[str] = None,
):
    if not files_data:
        return
    
    logger.info(f"[UPLOAD] Uploading files for project {project_id} ({len(files_data)} files)")
    
    try:
        client = await db.client
        
        if not account_id:
            result = await client.table('projects').select('account_id').eq('project_id', project_id).execute()
            if result.data:
                account_id = str(result.data[0].get('account_id'))
        
        sandbox_info = await resolve_sandbox(
            project_id=project_id,
            account_id=account_id,
            db_client=client,
            require_started=True
        )
        
        if not sandbox_info:
            logger.info(f"[UPLOAD] No sandbox for project {project_id} - files cached in Redis only")
            return
        
        logger.info(f"[UPLOAD] Sandbox {sandbox_info.sandbox_id} ready, uploading {len(files_data)} files...")
        uploads_dir = get_uploads_directory()
        uploaded_count = 0
        
        for filename, content_bytes, mime_type, _ in files_data:
            try:
                unique_filename = await generate_unique_filename(sandbox_info.sandbox, uploads_dir, filename)
                target_path = f"{uploads_dir}/{unique_filename}"
                
                if hasattr(sandbox_info.sandbox, 'fs') and hasattr(sandbox_info.sandbox.fs, 'upload_file'):
                    await sandbox_info.sandbox.fs.upload_file(content_bytes, target_path)
                    uploaded_count += 1
                    logger.debug(f"[UPLOAD] Complete: {filename} -> {target_path}")
            except Exception as e:
                logger.warning(f"[UPLOAD] Failed for {filename}: {str(e)}")
        
        logger.info(f"[UPLOAD] Complete: {uploaded_count}/{len(files_data)} files to sandbox {sandbox_info.sandbox_id}")
                
    except Exception as e:
        logger.warning(f"[UPLOAD] Error for project {project_id}: {str(e)}")


async def upload_staged_files_to_sandbox(
    project_id: str,
    thread_id: str,
    staged_files: List[Dict[str, Any]],
    account_id: str,
):
    if not staged_files:
        return
    
    logger.info(f"[UPLOAD] Uploading staged files for project {project_id} ({len(staged_files)} files)")
    
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
                logger.warning(f"[UPLOAD] Could not download staged file {sf['file_id']}")
        
        if not files_data:
            logger.warning(f"[UPLOAD] No staged files could be downloaded")
            return
        
        sandbox_info = await resolve_sandbox(
            project_id=project_id,
            account_id=account_id,
            db_client=client,
            require_started=True
        )
        
        if not sandbox_info:
            logger.info(f"[UPLOAD] No sandbox for project {project_id}")
            return
        
        logger.info(f"[UPLOAD] Sandbox {sandbox_info.sandbox_id} ready, uploading {len(files_data)} staged files...")
        uploads_dir = get_uploads_directory()
        uploaded_count = 0
        
        for filename, content_bytes, mime_type, _ in files_data:
            try:
                unique_filename = await generate_unique_filename(sandbox_info.sandbox, uploads_dir, filename)
                target_path = f"{uploads_dir}/{unique_filename}"
                
                if hasattr(sandbox_info.sandbox, 'fs') and hasattr(sandbox_info.sandbox.fs, 'upload_file'):
                    await sandbox_info.sandbox.fs.upload_file(content_bytes, target_path)
                    uploaded_count += 1
                    logger.debug(f"[UPLOAD] Staged complete: {filename} -> {target_path}")
            except Exception as e:
                logger.warning(f"[UPLOAD] Staged failed for {filename}: {str(e)}")
        
        logger.info(f"[UPLOAD] Staged complete: {uploaded_count}/{len(files_data)} files to sandbox {sandbox_info.sandbox_id}")
                
    except Exception as e:
        logger.warning(f"[UPLOAD] Staged error for project {project_id}: {str(e)}")


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


async def handle_file_uploads_fast(
    files: List[UploadFile],
    project_id: str,
    prompt: str = "",
    thread_id: Optional[str] = None,
    account_id: Optional[str] = None,
) -> str:
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
                logger.info(f"[UPLOAD] Cached {len(parsed_contents)} parsed files for thread {tid}")
            except Exception as cache_error:
                logger.warning(f"Failed to cache parsed files: {cache_error}")
        
        if project_id:
            await upload_files_to_sandbox(project_id, tid, files_data, account_id)
    
    return message_content


async def handle_staged_files_for_thread(
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
            logger.info(f"[UPLOAD] Cached {len(parsed_contents)} staged files for thread {thread_id}")
        except Exception as cache_error:
            logger.warning(f"Failed to cache staged files: {cache_error}")
    
    await upload_staged_files_to_sandbox(
        project_id=project_id,
        thread_id=thread_id,
        staged_files=staged_files,
        account_id=account_id
    )
    
    return message_content, image_contexts


async def ensure_sandbox_for_thread(client, project_id: str, files: Optional[List[Any]] = None):
    result = await client.table('projects').select('account_id').eq('project_id', project_id).execute()
    
    if not result.data:
        logger.warning(f"Project {project_id} not found")
        return None, None
    
    account_id = str(result.data[0].get('account_id')) if result.data[0].get('account_id') else None
    
    if not files or len(files) == 0:
        logger.debug(f"No files to upload for project {project_id}")
        return None, None
    
    sandbox_info = await resolve_sandbox(
        project_id=project_id,
        account_id=account_id,
        db_client=client,
        require_started=True
    )
    
    if sandbox_info:
        return sandbox_info.sandbox, sandbox_info.sandbox_id
    
    return None, None
