import uuid
import asyncio
import io
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Tuple
from fastapi import APIRouter, HTTPException, Depends, File, UploadFile, Form
from pydantic import BaseModel

from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.utils.fast_parse import parse, format_file_size, sanitize_filename_for_path, FileType, normalize_mime_type
from core.services.supabase import DBConnection

router = APIRouter(tags=["staged-files"])

STAGED_FILES_BUCKET = "staged-files"
MAX_FILE_SIZE = 50 * 1024 * 1024
SIGNED_URL_EXPIRY = 3600
MAX_IMAGE_WIDTH = 2048
MAX_IMAGE_HEIGHT = 2048
JPEG_QUALITY = 85

def sanitize_for_postgres(text: Optional[str]) -> Optional[str]:
    if text is None:
        return None
    return text.replace('\x00', '')


def is_image_mime(mime_type: str) -> bool:
    return mime_type.startswith('image/') and mime_type != 'image/svg+xml'


def compress_image(image_bytes: bytes, mime_type: str) -> Tuple[bytes, str]:
    try:
        from PIL import Image
        
        img = Image.open(io.BytesIO(image_bytes))
        
        if img.mode in ('RGBA', 'LA', 'P'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = background
        
        width, height = img.size
        if width > MAX_IMAGE_WIDTH or height > MAX_IMAGE_HEIGHT:
            ratio = min(MAX_IMAGE_WIDTH / width, MAX_IMAGE_HEIGHT / height)
            new_width = int(width * ratio)
            new_height = int(height * ratio)
            img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
            logger.debug(f"Resized image from {width}x{height} to {new_width}x{new_height}")
        
        output = io.BytesIO()
        
        if mime_type == 'image/gif':
            img.save(output, format='GIF', optimize=True)
            return output.getvalue(), 'image/gif'
        elif mime_type == 'image/png':
            img.save(output, format='PNG', optimize=True, compress_level=6)
            return output.getvalue(), 'image/png'
        else:
            img.save(output, format='JPEG', quality=JPEG_QUALITY, optimize=True)
            return output.getvalue(), 'image/jpeg'
    except Exception as e:
        logger.warning(f"Image compression failed: {e}, using original")
        return image_bytes, mime_type


class StagedFileResponse(BaseModel):
    file_id: str
    filename: str
    storage_path: str
    mime_type: str
    file_size: int
    parsed_preview: Optional[str] = None
    image_url: Optional[str] = None
    status: str

class StagedFilesListResponse(BaseModel):
    files: List[StagedFileResponse]


@router.post("/stage", response_model=StagedFileResponse, summary="Stage a file for later use")
async def stage_file(
    file: UploadFile = File(...),
    file_id: Optional[str] = Form(None),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    db = DBConnection()
    client = await db.client
    
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename is required")
    
    content = await file.read()
    file_size = len(content)
    
    if file_size > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413, 
            detail=f"File size ({format_file_size(file_size)}) exceeds limit ({format_file_size(MAX_FILE_SIZE)})"
        )
    
    if file_size == 0:
        raise HTTPException(status_code=400, detail="Empty file not allowed")
    
    generated_file_id = file_id or str(uuid.uuid4())
    original_filename = file.filename.replace('/', '_').replace('\\', '_')
    storage_safe_filename = sanitize_filename_for_path(file.filename)
    raw_mime_type = file.content_type or "application/octet-stream"
    mime_type = normalize_mime_type(raw_mime_type)
    
    storage_path = f"{user_id}/{generated_file_id}/{storage_safe_filename}"
    image_public_url = None
    
    async def upload_to_storage():
        try:
            await client.storage.from_(STAGED_FILES_BUCKET).upload(
                storage_path,
                content,
                {"content-type": mime_type}
            )
            return True
        except Exception as e:
            logger.error(f"Failed to upload staged file to storage: {e}")
            raise HTTPException(status_code=500, detail=f"Storage upload failed: {str(e)}")
    
    async def compress_and_store_image():
        nonlocal image_public_url
        if not is_image_mime(mime_type):
            return
        
        try:
            loop = asyncio.get_event_loop()
            compressed_bytes, compressed_mime = await loop.run_in_executor(
                None, compress_image, content, mime_type
            )
            
            ext_map = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp'}
            ext = ext_map.get(compressed_mime, 'jpg')
            
            compressed_path = f"{user_id}/{generated_file_id}/compressed.{ext}"
            
            await client.storage.from_(STAGED_FILES_BUCKET).upload(
                compressed_path,
                compressed_bytes,
                {"content-type": compressed_mime}
            )
            
            image_public_url = compressed_path
            logger.info(f"📷 Stored compressed image: {compressed_path}")
            
        except Exception as e:
            logger.warning(f"Failed to compress/store image: {e}")
    
    def parse_file():
        import time
        parse_start = time.time()
        try:
            logger.info(f"🔍 [FAST_PARSE] Starting parse for {original_filename} ({format_file_size(file_size)}, mime: {mime_type})")
            result = parse(content, original_filename, mime_type)
            parse_time = (time.time() - parse_start) * 1000
            
            if result.success and result.file_type != FileType.IMAGE:
                header_parts = [f"# {original_filename}"]
                meta = result.metadata
                if meta.get("total_pages"):
                    header_parts.append(f"Pages: {meta['total_pages']}")
                if meta.get("sheet_count"):
                    header_parts.append(f"Sheets: {meta['sheet_count']}")
                if meta.get("slide_count"):
                    header_parts.append(f"Slides: {meta['slide_count']}")
                header_parts.append(f"Size: {file_size:,} bytes")
                header_parts.append("")
                
                formatted_content = "\n".join(header_parts) + result.content
                preview = formatted_content[:5000] if len(formatted_content) > 5000 else formatted_content
                content_len = len(formatted_content)
                logger.info(f"✅ [FAST_PARSE] Success: {original_filename} -> {result.file_type.value}, {content_len:,} chars extracted in {parse_time:.1f}ms")
                return formatted_content, preview
            elif result.success and result.file_type == FileType.IMAGE:
                logger.info(f"📷 [FAST_PARSE] Image detected: {original_filename} in {parse_time:.1f}ms (no text extraction)")
            else:
                logger.warning(f"⚠️ [FAST_PARSE] Parse failed for {original_filename}: {result.error or 'unknown'} in {parse_time:.1f}ms")
            return None, None
        except Exception as e:
            parse_time = (time.time() - parse_start) * 1000
            logger.warning(f"❌ [FAST_PARSE] Exception parsing {original_filename}: {e} in {parse_time:.1f}ms")
            return None, None
    
    upload_task = asyncio.create_task(upload_to_storage())
    image_task = asyncio.create_task(compress_and_store_image())
    
    import time
    parse_executor_start = time.time()
    loop = asyncio.get_event_loop()
    parsed_content, parsed_preview = await loop.run_in_executor(None, parse_file)
    logger.debug(f"⏱️ [FAST_PARSE] Executor completed in {(time.time() - parse_executor_start) * 1000:.1f}ms")
    
    await upload_task
    await image_task
    
    try:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=24)
        
        safe_parsed_content = sanitize_for_postgres(
            parsed_content[:100000] if parsed_content and len(parsed_content) > 100000 else parsed_content
        )
        
        insert_data = {
            "file_id": generated_file_id,
            "account_id": user_id,
            "filename": original_filename,
            "storage_path": storage_path,
            "mime_type": mime_type,
            "file_size": file_size,
            "parsed_content": safe_parsed_content,
            "parse_status": "completed" if (parsed_content or image_public_url) else "failed",
            "expires_at": expires_at.isoformat(),
        }
        
        if image_public_url:
            insert_data["image_url"] = image_public_url
        
        await client.table('staged_files').insert(insert_data).execute()
        
        logger.info(f"✅ Staged file {generated_file_id}: {original_filename} ({format_file_size(file_size)})" + 
                   (f" [image: {image_public_url[:50]}...]" if image_public_url else ""))
        
    except Exception as e:
        logger.error(f"Failed to save staged file metadata: {e}")
        try:
            await client.storage.from_(STAGED_FILES_BUCKET).remove([storage_path])
        except:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to save file metadata: {str(e)}")
    
    return StagedFileResponse(
        file_id=generated_file_id,
        filename=original_filename,
        storage_path=storage_path,
        mime_type=mime_type,
        file_size=file_size,
        parsed_preview=parsed_preview,
        image_url=image_public_url,
        status="ready"
    )


@router.get("/staged", response_model=StagedFilesListResponse, summary="List staged files")
async def list_staged_files(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    db = DBConnection()
    client = await db.client
    
    result = await client.table('staged_files').select(
        'file_id, filename, storage_path, mime_type, file_size, parse_status'
    ).eq('account_id', user_id).is_('thread_id', 'null').execute()
    
    files = []
    for row in result.data or []:
        files.append(StagedFileResponse(
            file_id=row['file_id'],
            filename=row['filename'],
            storage_path=row['storage_path'],
            mime_type=row['mime_type'],
            file_size=row['file_size'],
            status="ready" if row['parse_status'] == 'completed' else row['parse_status']
        ))
    
    return StagedFilesListResponse(files=files)


@router.delete("/staged/{file_id}", summary="Delete a staged file")
async def delete_staged_file(
    file_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    db = DBConnection()
    client = await db.client
    
    result = await client.table('staged_files').select(
        'id, storage_path'
    ).eq('file_id', file_id).eq('account_id', user_id).execute()
    
    if not result.data:
        raise HTTPException(status_code=404, detail="Staged file not found")
    
    file_record = result.data[0]
    
    try:
        await client.storage.from_(STAGED_FILES_BUCKET).remove([file_record['storage_path']])
    except Exception as e:
        logger.warning(f"Failed to delete file from storage: {e}")
    
    await client.table('staged_files').delete().eq('id', file_record['id']).execute()
    
    logger.info(f"🗑️ Deleted staged file {file_id}")
    
    return {"status": "deleted", "file_id": file_id}


async def get_staged_files_for_thread(
    file_ids: List[str],
    user_id: str,
    thread_id: str
) -> List[dict]:
    db = DBConnection()
    client = await db.client
    
    logger.info(f"📎 [STAGED_FILES] Retrieving {len(file_ids)} staged files for thread {thread_id}")
    
    result = await client.table('staged_files').select(
        'file_id, filename, storage_path, mime_type, file_size, parsed_content, image_url'
    ).eq('account_id', user_id).in_('file_id', file_ids).execute()
    
    if not result.data:
        logger.warning(f"⚠️ [STAGED_FILES] No staged files found for file_ids: {file_ids}")
        return []
    
    files = []
    for row in result.data:
        image_url = None
        image_path = row.get('image_url')
        if image_path and not image_path.startswith('http'):
            try:
                signed = await client.storage.from_(STAGED_FILES_BUCKET).create_signed_url(
                    image_path, SIGNED_URL_EXPIRY
                )
                image_url = signed.get('signedURL') or signed.get('signed_url')
            except Exception as e:
                logger.warning(f"Failed to generate signed URL for {image_path}: {e}")
        elif image_path:
            image_url = image_path
        
        parsed_len = len(row['parsed_content']) if row['parsed_content'] else 0
        has_image = bool(image_url)
        logger.debug(f"  📄 [STAGED_FILES] {row['filename']}: {row['file_size']:,} bytes, parsed_content: {parsed_len:,} chars, has_image: {has_image}")
        
        files.append({
            "file_id": row['file_id'],
            "filename": row['filename'],
            "storage_path": row['storage_path'],
            "mime_type": row['mime_type'],
            "file_size": row['file_size'],
            "parsed_content": row['parsed_content'],
            "image_url": image_url
        })
    
    total_parsed = sum(len(f['parsed_content']) for f in files if f['parsed_content'])
    total_images = sum(1 for f in files if f['image_url'])
    logger.info(f"✅ [STAGED_FILES] Retrieved {len(files)} files for thread {thread_id}: {total_parsed:,} chars parsed, {total_images} images")
    
    return files


async def get_staged_file_content(file_id: str, user_id: str) -> Optional[bytes]:
    db = DBConnection()
    client = await db.client
    
    result = await client.table('staged_files').select(
        'storage_path'
    ).eq('file_id', file_id).eq('account_id', user_id).execute()
    
    if not result.data:
        return None
    
    storage_path = result.data[0]['storage_path']
    
    try:
        response = await client.storage.from_(STAGED_FILES_BUCKET).download(storage_path)
        return response
    except Exception as e:
        logger.error(f"Failed to download staged file {file_id}: {e}")
        return None
