"""
Utility functions for handling image operations.
"""

import base64
import uuid
from datetime import datetime
from typing import Tuple
from core.utils.logger import logger
from core.services.supabase import DBConnection

async def upload_base64_image(base64_data: str, bucket_name: str = "image-uploads") -> str:
    """Upload a base64 encoded image to Supabase storage and return the URL.
    
    Args:
        base64_data (str): Base64 encoded image data (with or without data URL prefix)
        bucket_name (str): Name of the storage bucket to upload to
        
    Returns:
        str: Public URL of the uploaded image
    """
    try:
        # Remove data URL prefix if present
        if base64_data.startswith('data:'):
            base64_data = base64_data.split(',')[1]
        
        # Decode base64 data
        image_data = base64.b64decode(base64_data)
        
        # Generate unique filename
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        unique_id = str(uuid.uuid4())[:8]
        filename = f"image_{timestamp}_{unique_id}.png"
        
        # Upload to Supabase storage
        db = DBConnection()
        client = await db.client
        storage_response = await client.storage.from_(bucket_name).upload(
            filename,
            image_data,
            {"content-type": "image/png"}
        )
        
        # Get public URL
        public_url = await client.storage.from_(bucket_name).get_public_url(filename)
        
        logger.debug(f"Successfully uploaded image to {public_url}")
        return public_url
        
    except Exception as e:
        logger.error(f"Error uploading base64 image: {e}")
        raise RuntimeError(f"Failed to upload image: {str(e)}")

async def upload_image_bytes(image_bytes: bytes, content_type: str = "image/png", bucket_name: str = "agent-profile-images") -> str:
    try:
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        unique_id = str(uuid.uuid4())[:8]
        ext = "png"
        if content_type == "image/jpeg" or content_type == "image/jpg":
            ext = "jpg"
        elif content_type == "image/webp":
            ext = "webp"
        elif content_type == "image/gif":
            ext = "gif"
        filename = f"agent_profile_{timestamp}_{unique_id}.{ext}"

        db = DBConnection()
        client = await db.client
        await client.storage.from_(bucket_name).upload(
            filename,
            image_bytes,
            {"content-type": content_type}
        )

        public_url = await client.storage.from_(bucket_name).get_public_url(filename)
        logger.debug(f"Successfully uploaded agent profile image to {public_url}")
        return public_url
    except Exception as e:
        logger.error(f"Error uploading image bytes: {e}")
        raise RuntimeError(f"Failed to upload image: {str(e)}") 

async def upload_user_profile_picture(
    user_id: str,
    image_bytes: bytes,
    content_type: str = "image/png",
    bucket_name: str = "user-profile-pictures",
) -> Tuple[str, str]:
    """
    Upload a profile picture for a specific user and return the public URL and storage path.
    """
    try:
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        unique_id = str(uuid.uuid4())[:8]

        ext = "png"
        normalized_content_type = (content_type or '').lower()
        if normalized_content_type in ("image/jpeg", "image/jpg"):
            ext = "jpg"
        elif normalized_content_type == "image/webp":
            ext = "webp"
        elif normalized_content_type == "image/gif":
            ext = "gif"

        filename = f"profile_{timestamp}_{unique_id}.{ext}"
        storage_path = f"{user_id}/{filename}"

        db = DBConnection()
        client = await db.client
        await client.storage.from_(bucket_name).upload(
            storage_path,
            image_bytes,
            {"content-type": normalized_content_type or "image/png"}
        )

        public_url_result = await client.storage.from_(bucket_name).get_public_url(storage_path)
        if isinstance(public_url_result, dict):
            public_url = public_url_result.get('publicUrl') or public_url_result.get('public_url')
        else:
            public_url = public_url_result

        if not public_url:
            raise RuntimeError("Supabase did not return a public URL for the uploaded profile picture")

        logger.debug(f"Successfully uploaded profile picture for user {user_id} to {public_url}")
        return public_url, storage_path
    except Exception as e:
        logger.error(f"Error uploading profile picture for user {user_id}: {e}")
        raise RuntimeError(f"Failed to upload profile picture: {str(e)}")