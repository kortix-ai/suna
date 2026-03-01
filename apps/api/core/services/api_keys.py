"""
API Keys Service

This module provides functionality for managing API keys including:
- Creating new API keys with UUIDs
- Validating API keys for authentication
- Managing expiration and revocation
- CRUD operations for user API keys

MIGRATION STATUS:
- Redis caching: Active (no migration needed)
- Database operations: TODO - Requires Convex endpoints for api_keys table
"""

import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict
from uuid import UUID, uuid4
import secrets
import string
import hmac
import hashlib
import time
from collections import OrderedDict
from pydantic import BaseModel, Field, field_validator
from fastapi import HTTPException
from core.utils.logger import logger
from core.services import redis
from core.utils.config import config

# Using Convex client for API key operations
from core.services.convex_client import get_convex_client

# TODO: Migrate to Convex once api_keys endpoints are available
# Convex endpoints needed:
# - POST /api/api-keys - Create API key
# - GET /api/api-keys?accountId=... - List API keys
# - GET /api/api-keys/validate?publicKey=... - Validate API key
# - PATCH /api/api-keys/revoke - Revoke API key
# - DELETE /api/api-keys - Delete API key


class APIKeyStatus:
    ACTIVE = "active"
    REVOKED = "revoked"
    EXPIRED = "expired"


class APIKeyCreateRequest(BaseModel):
    """Request model for creating a new API key"""

    title: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Human-readable title for the API key",
    )
    description: Optional[str] = Field(
        None, description="Optional description for the API key"
    )
    expires_in_days: Optional[int] = Field(
        None, gt=0, le=365, description="Number of days until expiration (max 365)"
    )

    @field_validator("title")
    def validate_title(cls, v):
        if not v or not v.strip():
            raise ValueError("Title cannot be empty")
        return v.strip()


class APIKeyResponse(BaseModel):
    """Response model for API key information (without the secret key)"""

    key_id: UUID
    public_key: str
    title: str
    description: Optional[str]
    status: str
    expires_at: Optional[datetime]
    last_used_at: Optional[datetime]
    created_at: datetime


class APIKeyCreateResponse(BaseModel):
    """Response model for newly created API key (includes both keys)"""

    key_id: UUID
    public_key: str
    secret_key: str  # Only returned on creation
    title: str
    description: Optional[str]
    status: str
    expires_at: Optional[datetime]
    created_at: datetime


class APIKeyValidationResult(BaseModel):
    """Result of API key validation"""

    is_valid: bool
    account_id: Optional[UUID] = None
    key_id: Optional[UUID] = None
    error_message: Optional[str] = None


class APIKeyService:
    """
    Service for managing API keys with performance optimizations

    Performance Features:
    - HMAC-SHA256 hashing (100x faster than bcrypt)
    - Redis caching for validation results (2min TTL)
    - Throttled last_used_at updates (max once per 15min per key, configurable)
    - Cached user lookups (5min TTL)
    - Asynchronous operations where possible
    - In-memory fallback throttling when Redis unavailable
    - Streamlined database schema without unnecessary triggers

    MIGRATION NOTE:
    - All database operations currently use Supabase
    - TODO: Migrate to Convex once api_keys endpoints are available
    """

    # Class-level in-memory throttle cache (fallback when Redis unavailable)
    # LRU cache with max size to prevent unbounded growth
    _throttle_cache: OrderedDict[str, float] = OrderedDict()
    _max_throttle_cache_size = 500  # Maximum entries before cleanup

    def __init__(self):
        """Initialize API key service with Convex client."""
        self.convex = get_convex_client()

    def _generate_key_pair(self) -> tuple[str, str]:
        """
        Generate a public key and secret key pair

        Returns:
            tuple: (public_key, secret_key) where public_key starts with 'pk_' and secret_key starts with 'sk_'
        """
        # Generate random strings for both keys
        pk_suffix = "".join(
            secrets.choice(string.ascii_letters + string.digits) for _ in range(32)
        )
        sk_suffix = "".join(
            secrets.choice(string.ascii_letters + string.digits) for _ in range(32)
        )

        public_key = f"pk_{pk_suffix}"
        secret_key = f"sk_{sk_suffix}"

        return public_key, secret_key

    def _get_secret_key(self) -> str:
        """Get the secret key for HMAC hashing"""
        return config.API_KEY_SECRET

    def _hash_secret_key(self, secret_key: str) -> str:
        """
        Hash a secret key using HMAC-SHA256 (much faster than bcrypt)

        Args:
            secret_key: The secret key to hash

        Returns:
            str: The HMAC-SHA256 hash of the secret key
        """
        secret = self._get_secret_key().encode("utf-8")
        return hmac.new(secret, secret_key.encode("utf-8"), hashlib.sha256).hexdigest()

    def _verify_secret_key(self, secret_key: str, hashed_key: str) -> bool:
        """
        Verify a secret key against its hash using constant-time comparison

        Args:
            secret_key: The secret key to verify
            hashed_key: The stored hash

        Returns:
            bool: True if the secret key matches the hash
        """
        try:
            expected_hash = self._hash_secret_key(secret_key)
            return hmac.compare_digest(expected_hash, hashed_key)
        except Exception:
            return False

    async def create_api_key(
        self, account_id: UUID, request: APIKeyCreateRequest
    ) -> APIKeyCreateResponse:
        """
        Create a new API key for the specified account

        Args:
            account_id: The account ID to create the key for
            request: The API key creation request

        Returns:
            APIKeyCreateResponse containing the new API key details including both keys
        """
        try:
            # Calculate expiration date if specified
            expires_at = None
            if request.expires_in_days:
                expires_at = datetime.now(timezone.utc) + timedelta(
                    days=request.expires_in_days
                )

            # Generate public and secret key pair
            public_key, secret_key = self._generate_key_pair()

            # Hash the secret key for storage
            secret_key_hash = self._hash_secret_key(secret_key)

            # MIGRATED: Using Convex client for API key operations
            account_id = getattr(self, 'account_id', None)

            # Generate public and secret key pair
            public_key, secret_key = self._generate_key_pair()

            # Hash the secret key for storage
            secret_key_hash = self._hash_secret_key(secret_key)

            # Create API key via Convex
            result = await self.convex.create_api_key(
                key_id=str(uuid4()),
                account_id=str(account_id),
                public_key=public_key,
                secret_key_hash=secret_key_hash,
                title=request.title,
                description=request.description,
                expires_at=expires_at.isoformat() if expires_at else None
            )

            if not result:
                raise HTTPException(status_code=500, detail="Failed to create API key")

            return APIKeyCreateResponse(
                key_id=result["key_id"],
                public_key=public_key,
                secret_key=secret_key,  # Only returned on creation
                title=result.get("title", request.title),
                description=result.get("description"),
                status=result.get("status", APIKeyStatus.ACTIVE),
                created_at=datetime.fromisoformat(result["created_at"]),
                expires_at=expires_at,
            )

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error creating API key: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail="Failed to create API key")

    async def list_api_keys(self, account_id: UUID) -> List[APIKeyResponse]:
        """
        List all API keys for the specified account

        Args:
            account_id: The account ID to list keys for

        Returns:
            List of APIKeyResponse objects
        """
        try:
            # MIGRATED: Using Convex client for API key operations
            result = await self.convex.list_api_keys(str(account_id))
            
            if not result:
                return []
            
            keys = []
            for key_data in result:
                keys.append(APIKeyResponse(
                    key_id=UUID(key_data["key_id"]),
                    public_key=key_data["public_key"],
                    title=key_data.get("title", ""),
                    description=key_data.get("description"),
                    status=key_data.get("status", APIKeyStatus.ACTIVE),
                    expires_at=datetime.fromisoformat(key_data["expires_at"]) if key_data.get("expires_at") else None,
                    last_used_at=datetime.fromisoformat(key_data["last_used_at"]) if key_data.get("last_used_at") else None,
                    created_at=datetime.fromisoformat(key_data["created_at"]),
                ))
            
            return keys

        except Exception as e:
            logger.error(f"Error listing API keys: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail="Failed to list API keys")

    async def revoke_api_key(self, account_id: UUID, key_id: UUID) -> bool:
        """
        Revoke an API key

        Args:
            account_id: The account ID that owns the key
            key_id: The ID of the key to revoke

        Returns:
            True if successful, False otherwise
        """
        try:
            # MIGRATED: Using Convex client for API key operations
            result = await self.convex.revoke_api_key(str(key_id), str(account_id))
            
            if not result:
                raise HTTPException(status_code=404, detail="API key not found")
            
            return True

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error revoking API key: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail="Failed to revoke API key")

    async def validate_api_key(
        self, public_key: str, secret_key: str
    ) -> APIKeyValidationResult:
        """
        Validate an API key pair with Redis caching for performance

        Args:
            public_key: The public key (starts with 'pk_')
            secret_key: The secret key (starts with 'sk_')

        Returns:
            APIKeyValidationResult with validation status and account info
        """
        try:
            # Validate key format
            if not public_key.startswith("pk_") or not secret_key.startswith("sk_"):
                return APIKeyValidationResult(
                    is_valid=False, error_message="Invalid API key format"
                )

            # Check Redis cache first (cache key includes secret hash for security)
            cache_key = f"api_key:{public_key}:{self._hash_secret_key(secret_key)[:8]}"

            try:
                cached_result = await redis.get(cache_key)
                if cached_result:
                    import json

                    cached_data = json.loads(cached_result)
                    logger.debug(f"API key validation cache hit for {public_key}")
                    return APIKeyValidationResult(
                        is_valid=cached_data["is_valid"],
                        account_id=(
                            UUID(cached_data["account_id"])
                            if cached_data["account_id"]
                            else None
                        ),
                        key_id=(
                            UUID(cached_data["key_id"])
                            if cached_data["key_id"]
                            else None
                        ),
                        error_message=cached_data.get("error_message"),
                    )
            except Exception as e:
                logger.warning(f"Redis cache lookup failed: {e}")
                # Continue without cache

            # MIGRATED: Using Convex client for API key validation
            key_data = await self.convex.validate_api_key(public_key)

            if not key_data:
                result = APIKeyValidationResult(
                    is_valid=False, error_message="Invalid API key"
                )
                await self._cache_validation_result(cache_key, result)
                return result

            # Check if key is revoked
            if key_data.get("status") == APIKeyStatus.REVOKED:
                result = APIKeyValidationResult(
                    is_valid=False, error_message="API key has been revoked"
                )
                await self._cache_validation_result(cache_key, result)
                return result

            # Check expiration
            if key_data.get("expires_at"):
                expires_at = datetime.fromisoformat(key_data["expires_at"])
                if datetime.now(timezone.utc) > expires_at:
                    result = APIKeyValidationResult(
                        is_valid=False, error_message="API key has expired"
                    )
                    await self._cache_validation_result(cache_key, result)
                    return result

            # Verify secret key
            stored_hash = key_data.get("secret_key_hash", "")
            if not self._verify_secret_key(secret_key, stored_hash):
                result = APIKeyValidationResult(
                    is_valid=False, error_message="Invalid API key"
                )
                await self._cache_validation_result(cache_key, result)
                return result

            # Update last_used_at in background (throttled)
            key_id = key_data.get("key_id")
            if key_id:
                asyncio.create_task(self._update_last_used_throttled(key_id))

            result = APIKeyValidationResult(
                is_valid=True,
                account_id=UUID(key_data["account_id"]),
                key_id=UUID(key_id) if key_id else None,
            )

            # Cache successful validation
            await self._cache_validation_result(cache_key, result)

            return result

        except Exception as e:
            logger.error(f"Error validating API key: {e}", exc_info=True)
            return APIKeyValidationResult(
                is_valid=False, error_message="Internal server error"
            )

    async def _cache_validation_result(
        self, cache_key: str, result: APIKeyValidationResult, ttl: int = 120
    ):
        """Cache validation result in Redis"""
        try:
            import json

            cache_data = {
                "is_valid": result.is_valid,
                "account_id": str(result.account_id) if result.account_id else None,
                "key_id": str(result.key_id) if result.key_id else None,
                "error_message": result.error_message,
            }
            await redis.setex(cache_key, ttl, json.dumps(cache_data))
        except Exception as e:
            logger.warning(f"Failed to cache validation result: {e}")

    async def _update_last_used_throttled(self, key_id: str):
        """Update last used timestamp with throttling to reduce DB load"""
        throttle_interval = config.API_KEY_LAST_USED_THROTTLE_SECONDS
        current_time = time.time()

        # Try Redis first - optimized to use SET NX pattern (1 call instead of 2)
        try:
            throttle_key = f"last_used_throttle:{key_id}"

            # Use SET with NX (set-if-not-exists) to atomically check and set
            # This reduces from 2 Redis calls (GET + SETEX) to 1 call
            # Returns False if key already exists (throttled), True if set successfully
            was_set = await redis.set(throttle_key, "1", ex=throttle_interval, nx=True, timeout=2.0)
            if not was_set:
                # Key already exists - already updated within throttle interval, skip
                return

        except Exception as redis_error:
            # Fallback to in-memory throttling when Redis unavailable
            logger.debug(
                f"Redis unavailable for throttling, using in-memory fallback: {redis_error}"
            )

            # Clean up expired entries and enforce LRU limit
            cutoff_time = current_time - (throttle_interval * 2)  # Keep extra buffer
            
            # Remove expired entries
            expired_keys = [
                k for k, v in self._throttle_cache.items() 
                if v < cutoff_time
            ]
            for k in expired_keys:
                self._throttle_cache.pop(k, None)
            
            # Enforce LRU limit (remove oldest if over limit)
            while len(self._throttle_cache) > self._max_throttle_cache_size:
                self._throttle_cache.popitem(last=False)  # Remove oldest

            # Check in-memory throttle
            last_update_time = self._throttle_cache.get(key_id, 0)
            if current_time - last_update_time < throttle_interval:
                # Already updated within throttle interval, skip
                return

            # Set in-memory throttle (move to end for LRU)
            if key_id in self._throttle_cache:
                self._throttle_cache.move_to_end(key_id)
            self._throttle_cache[key_id] = current_time

        # Update database
        # MIGRATED: Using Convex client for last_used_at update
        try:
            await self.convex.update_api_key_last_used(key_id)
            logger.debug(f"Updated last_used_at for key {key_id}")
        except Exception as e:
            logger.warning(f"Failed to update last_used_at for key {key_id}: {e}")

    async def _update_last_used_async(self, key_id: str):
        """Legacy method - kept for backwards compatibility"""
        await self._update_last_used_throttled(key_id)

    async def _clear_throttle(self, key_id: str):
        """Clear the throttle for a specific key (useful for testing)"""
        try:
            throttle_key = f"last_used_throttle:{key_id}"
            await redis.delete(throttle_key)
            logger.debug(f"Cleared throttle for key {key_id}")
        except Exception as e:
            logger.warning(f"Failed to clear throttle for key {key_id}: {e}")

    async def delete_api_key(self, account_id: UUID, key_id: UUID) -> bool:
        """
        Delete an API key permanently

        Args:
            account_id: The account ID that owns the key
            key_id: The ID of the key to delete

        Returns:
            True if successful, False otherwise
        """
        try:
            # MIGRATED: Using Convex client for API key deletion
            result = await self.convex.delete_api_key(str(key_id), str(account_id))
            
            if not result:
                raise HTTPException(status_code=404, detail="API key not found")

            return True

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error deleting API key: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail="Failed to delete API key")


# Create singleton instance
api_key_service = APIKeyService()
