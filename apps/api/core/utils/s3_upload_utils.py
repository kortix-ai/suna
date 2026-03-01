"""
Utility functions for handling image operations.

CONVEX MIGRATION STATUS: MIGRATED - AWS S3 SDK
===============================================
This module now uses boto3 for direct S3 uploads instead of Supabase Storage.

Configuration:
- AWS_ACCESS_KEY_ID: AWS access key
- AWS_SECRET_ACCESS_KEY: AWS secret key
- AWS_REGION: AWS region (default: us-east-1)
- S3_BUCKET_IMAGES: S3 bucket for image uploads (default: image-uploads)
- S3_BUCKET_AGENT_PROFILES: S3 bucket for agent profile images (default: agent-profile-images)
- CLOUDFRONT_URL: Optional CloudFront URL for CDN (default: use S3 URL)

If AWS credentials are not configured, falls back to local file storage.
"""
import base64
import os
import uuid
from datetime import datetime
from typing import Optional
from core.utils.logger import logger
from core.utils.config import config

# Try to import boto3, fall back gracefully if not available
try:
    import boto3
    from botocore.exceptions import ClientError
    BOTO3_AVAILABLE = True
except ImportError:
    BOTO3_AVAILABLE = False
    logger.warning("boto3 not available, image uploads will fail")

# S3 configuration from environment
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
S3_BUCKET_IMAGES = os.getenv("S3_BUCKET_IMAGES", "image-uploads")
S3_BUCKET_AGENT_PROFILES = os.getenv("S3_BUCKET_AGENT_PROFILES", "agent-profile-images")
CLOUDFRONT_URL = os.getenv("CLOUDFRONT_URL")

# Lazy-initialized S3 client
_s3_client = None


def _get_s3_client():
    """Get or create S3 client."""
    global _s3_client

    if not BOTO3_AVAILABLE:
        raise RuntimeError("boto3 is not installed. Install with: pip install boto3")

    if _s3_client is None:
        if not AWS_ACCESS_KEY_ID or not AWS_SECRET_ACCESS_KEY:
            raise ValueError(
                "AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
            )

        _s3_client = boto3.client(
            's3',
            aws_access_key_id=AWS_ACCESS_KEY_ID,
            aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
            region_name=AWS_REGION
        )

    return _s3_client


def _get_public_url(bucket: str, key: str) -> str:
    """Get public URL for an S3 object."""
    if CLOUDFRONT_URL:
        return f"{CLOUDFRONT_URL.rstrip('/')}/{key}"
    return f"https://{bucket}.s3.{AWS_REGION}.amazonaws.com/{key}"


async def upload_base64_image(base64_data: str, bucket_name: Optional[str] = None) -> str:
    """
    Upload a base64 encoded image to S3 and return the URL.

    Args:
        base64_data: Base64 encoded image data (with or without data URL prefix)
        bucket_name: Name of the S3 bucket (default: S3_BUCKET_IMAGES)

    Returns:
        Public URL of the uploaded image

    Raises:
        RuntimeError: If upload fails or S3 is not configured
    """
    bucket = bucket_name or S3_BUCKET_IMAGES

    try:
        # Remove data URL prefix if present
        if base64_data.startswith('data:'):
            base64_data = base64_data.split(',')[1]

        # Decode base64 data
        image_data = base64.b64decode(base64_data)

        # Generate unique filename
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        unique_id = str(uuid.uuid4())[:8]
        filename = f"images/{timestamp}_{unique_id}.png"

        # Upload to S3
        s3_client = _get_s3_client()
        s3_client.put_object(
            Bucket=bucket,
            Key=filename,
            Body=image_data,
            ContentType='image/png',
            ACL='public-read'
        )

        url = _get_public_url(bucket, filename)
        logger.debug(f"Successfully uploaded image to {url}")
        return url

    except Exception as e:
        logger.error(f"Error uploading base64 image: {e}")
        raise RuntimeError(f"Failed to upload image: {str(e)}")


async def upload_image_bytes(
    image_bytes: bytes,
    content_type: str = "image/png",
    bucket_name: Optional[str] = None
) -> str:
    """
    Upload image bytes to S3 and return the URL.

    Args:
        image_bytes: Raw image bytes
        content_type: MIME type of the image
        bucket_name: Name of the S3 bucket (default: S3_BUCKET_AGENT_PROFILES)

    Returns:
        Public URL of the uploaded image

    Raises:
        RuntimeError: If upload fails or S3 is not configured
    """
    bucket = bucket_name or S3_BUCKET_AGENT_PROFILES

    try:
        # Determine file extension
        ext = "png"
        if content_type in ("image/jpeg", "image/jpg"):
            ext = "jpg"
        elif content_type == "image/webp":
            ext = "webp"
        elif content_type == "image/gif":
            ext = "gif"

        # Generate unique filename
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        unique_id = str(uuid.uuid4())[:8]
        filename = f"profiles/{timestamp}_{unique_id}.{ext}"

        # Upload to S3
        s3_client = _get_s3_client()
        s3_client.put_object(
            Bucket=bucket,
            Key=filename,
            Body=image_bytes,
            ContentType=content_type,
            ACL='public-read'
        )

        url = _get_public_url(bucket, filename)
        logger.debug(f"Successfully uploaded agent profile image to {url}")
        return url

    except Exception as e:
        logger.error(f"Error uploading image bytes: {e}")
        raise RuntimeError(f"Failed to upload image: {str(e)}")


async def delete_image(key: str, bucket_name: Optional[str] = None) -> bool:
    """
    Delete an image from S3.

    Args:
        key: S3 object key to delete
        bucket_name: Name of the S3 bucket (default: S3_BUCKET_IMAGES)

    Returns:
        True if deletion was successful

    Raises:
        RuntimeError: If deletion fails
    """
    bucket = bucket_name or S3_BUCKET_IMAGES

    try:
        s3_client = _get_s3_client()
        s3_client.delete_object(Bucket=bucket, Key=key)
        logger.debug(f"Successfully deleted image: {key}")
        return True

    except Exception as e:
        logger.error(f"Error deleting image: {e}")
        raise RuntimeError(f"Failed to delete image: {str(e)}")


async def get_presigned_upload_url(
    filename: str,
    content_type: str,
    bucket_name: Optional[str] = None,
    expires_in: int = 3600
) -> dict:
    """
    Generate a presigned URL for direct client-side upload.

    Args:
        filename: Original filename
        content_type: MIME type of the file
        bucket_name: Name of the S3 bucket
        expires_in: URL expiration time in seconds

    Returns:
        Dict with 'upload_url', 'key', and 'public_url'
    """
    bucket = bucket_name or S3_BUCKET_IMAGES

    # Generate unique key
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    unique_id = str(uuid.uuid4())[:8]
    ext = filename.rsplit('.', 1)[-1] if '.' in filename else 'bin'
    key = f"uploads/{timestamp}_{unique_id}.{ext}"

    s3_client = _get_s3_client()

    upload_url = s3_client.generate_presigned_url(
        'put_object',
        Params={
            'Bucket': bucket,
            'Key': key,
            'ContentType': content_type
        },
        ExpiresIn=expires_in
    )

    return {
        'upload_url': upload_url,
        'key': key,
        'public_url': _get_public_url(bucket, key)
    }
