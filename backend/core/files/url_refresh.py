"""
URL refresh utilities for expired Supabase signed URLs.

This module provides functions to detect expired signed URLs in LLM messages
and regenerate them before making API calls.
"""
import asyncio
import base64
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.files.staged_files_api import STAGED_FILES_BUCKET, SIGNED_URL_EXPIRY


def is_supabase_signed_url(url: str) -> bool:
    """Check if a URL is a Supabase signed URL."""
    if not url or not isinstance(url, str):
        return False
    return '/object/sign/' in url or 'token=' in url


def extract_storage_path_from_url(url: str) -> Optional[str]:
    """
    Extract the storage path from a Supabase signed URL.

    URL format: https://xxx.supabase.co/storage/v1/object/sign/{bucket}/{path}?token=xxx

    Args:
        url: The signed URL

    Returns:
        The storage path or None if extraction fails
    """
    try:
        parsed = urlparse(url)
        path = parsed.path

        # Pattern: /storage/v1/object/sign/{bucket}/{storage_path}
        match = re.match(r'/storage/v1/object/sign/[^/]+/(.+)', path)
        if match:
            return match.group(1)

        return None
    except Exception as e:
        logger.warning(f"Failed to extract storage path from URL: {e}")
        return None


def is_signed_url_expired(url: str, buffer_seconds: int = 300) -> bool:
    """
    Check if a Supabase signed URL is expired or about to expire.

    Supabase signed URLs contain a JWT token with an 'exp' claim.

    Args:
        url: The signed URL to check
        buffer_seconds: Refresh if URL expires within this many seconds (default 5 min)

    Returns:
        True if expired or about to expire, False otherwise
    """
    if not is_supabase_signed_url(url):
        return False

    try:
        parsed = urlparse(url)
        query_params = parse_qs(parsed.query)
        token = query_params.get('token', [None])[0]

        if not token:
            return True  # No token = invalid

        # Decode JWT without verification (we just need the exp claim)
        # JWT format: header.payload.signature
        parts = token.split('.')
        if len(parts) != 3:
            return True  # Invalid JWT format

        # Decode payload (add padding if needed)
        payload = parts[1]
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += '=' * padding

        decoded = base64.urlsafe_b64decode(payload)
        claims = json.loads(decoded)

        exp_timestamp = claims.get('exp')
        if not exp_timestamp:
            return True  # No expiration = treat as expired

        # Check if expired or about to expire
        current_time = datetime.now(timezone.utc).timestamp()
        return current_time >= (exp_timestamp - buffer_seconds)

    except Exception as e:
        logger.warning(f"Failed to check URL expiration: {e}")
        return True  # On error, assume expired to be safe


async def refresh_signed_url(storage_path: str, bucket: str = STAGED_FILES_BUCKET) -> Optional[str]:
    """
    Generate a new signed URL for a storage path.

    Args:
        storage_path: The path in the storage bucket
        bucket: The bucket name

    Returns:
        New signed URL or None on failure
    """
    try:
        db = DBConnection()
        client = await db.client

        signed = await client.storage.from_(bucket).create_signed_url(
            storage_path, SIGNED_URL_EXPIRY
        )
        return signed.get('signedURL') or signed.get('signed_url')
    except Exception as e:
        logger.error(f"Failed to refresh signed URL for {storage_path}: {e}")
        return None


async def refresh_image_urls_in_messages(
    messages: List[Dict[str, Any]],
    thread_id: Optional[str] = None
) -> Tuple[List[Dict[str, Any]], int]:
    """
    Scan messages for expired image URLs and refresh them.
    Persists refreshed URLs to DB to avoid re-refreshing on each turn.

    Args:
        messages: List of LLM messages to process
        thread_id: Thread ID for cache invalidation (optional)

    Returns:
        Tuple of (updated messages, count of refreshed URLs)
    """
    # Collect URLs that need refresh: (message_id, image_url_obj, storage_path)
    urls_to_refresh: List[Tuple[Optional[str], Dict, str]] = []

    for msg in messages:
        content = msg.get('content')
        if not isinstance(content, list):
            continue

        message_id = msg.get('message_id')

        for part in content:
            if not isinstance(part, dict) or part.get('type') != 'image_url':
                continue

            image_url_obj = part.get('image_url', {})
            url = image_url_obj.get('url', '')

            if not is_supabase_signed_url(url):
                continue

            if not is_signed_url_expired(url):
                continue

            storage_path = extract_storage_path_from_url(url)

            if storage_path:
                urls_to_refresh.append((message_id, image_url_obj, storage_path))
            else:
                logger.warning(f"Cannot refresh URL - failed to extract storage path from: {url[:100]}...")

    if not urls_to_refresh:
        return messages, 0

    # Parallel refresh
    refreshed_message_ids: List[str] = []

    async def refresh_one(item: Tuple[Optional[str], Dict, str]) -> bool:
        message_id, image_url_obj, storage_path = item
        new_url = await refresh_signed_url(storage_path, STAGED_FILES_BUCKET)
        if new_url:
            image_url_obj['url'] = new_url
            if message_id:
                refreshed_message_ids.append(message_id)
            return True
        return False

    results = await asyncio.gather(*[refresh_one(item) for item in urls_to_refresh])
    refreshed_count = sum(1 for r in results if r)

    if refreshed_count > 0:
        logger.info(f"🔄 Refreshed {refreshed_count} expired image URL(s)")

        # Persist to DB and invalidate cache (fire and forget to not block LLM call)
        if refreshed_message_ids:
            # Get unique messages that were updated
            msgs_to_persist = {
                msg['message_id']: msg
                for msg in messages
                if msg.get('message_id') in refreshed_message_ids
            }
            asyncio.create_task(_persist_and_invalidate(msgs_to_persist, thread_id))

    return messages, refreshed_count


async def _persist_and_invalidate(
    messages_to_update: Dict[str, Dict],
    thread_id: Optional[str]
) -> None:
    """Persist refreshed URLs to DB and invalidate cache (background task)."""
    from core.threads.repo import update_message_content

    # Persist messages
    for message_id, msg in messages_to_update.items():
        try:
            content = msg.get('content')
            if content:
                await update_message_content(message_id, content)
                logger.debug(f"💾 Persisted refreshed URL for message {message_id}")
        except Exception as e:
            logger.warning(f"Failed to persist refreshed URL for message {message_id}: {e}")

    # Invalidate Redis cache
    if thread_id:
        try:
            from core.cache.runtime_cache import invalidate_message_history_cache
            await invalidate_message_history_cache(thread_id)
            logger.debug(f"🗑️ Invalidated message cache for thread {thread_id}")
        except Exception as e:
            logger.warning(f"Failed to invalidate cache for thread {thread_id}: {e}")
