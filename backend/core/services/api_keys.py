"""
API Keys Service

This module provides functionality for managing API keys including:
- Creating new API keys with UUIDs
- Validating API keys for authentication
- Managing expiration and revocation
- CRUD operations for user API keys
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
from pydantic import BaseModel, Field, field_validator
from fastapi import HTTPException
from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.services import redis
from core.utils.config import config


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
    """

    # Class-level in-memory throttle cache (fallback when Redis unavailable)
    _throttle_cache: Dict[str, float] = {}

    def __init__(self, db: DBConnection):
        self.db = db

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

            # Insert into database
            client = await self.db.client
            result = (
                await client.table("api_keys")
                .insert(
                    {
                        "public_key": public_key,
                        "secret_key_hash": secret_key_hash,
                        "account_id": str(account_id),
                        "title": request.title,
                        "description": request.description,
                        "expires_at": expires_at.isoformat() if expires_at else None,
                        "status": APIKeyStatus.ACTIVE,
                    }
                )
                .execute()
            )

            if not result.data:
                raise HTTPException(status_code=500, detail="Failed to create API key")

            key_data = result.data[0]

            logger.debug(
                "API key created successfully",
                account_id=str(account_id),
                key_id=key_data["key_id"],
                public_key=public_key,
                title=request.title,
            )

            return APIKeyCreateResponse(
                key_id=UUID(key_data["key_id"]),
                public_key=public_key,
                secret_key=secret_key,  # Only returned on creation
                title=key_data["title"],
                description=key_data["description"],
                status=key_data["status"],
                expires_at=(
                    datetime.fromisoformat(key_data["expires_at"])
                    if key_data["expires_at"]
                    else None
                ),
                created_at=datetime.fromisoformat(key_data["created_at"]),
            )

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
            client = await self.db.client
            result = (
                await client.table("api_keys")
                .select(
                    "key_id, public_key, title, description, status, expires_at, last_used_at, created_at"
                )
                .eq("account_id", str(account_id))
                .order("created_at", desc=True)
                .execute()
            )

            api_keys = []
            for key_data in result.data:
                api_keys.append(
                    APIKeyResponse(
                        key_id=UUID(key_data["key_id"]),
                        public_key=key_data["public_key"],
                        title=key_data["title"],
                        description=key_data["description"],
                        status=key_data["status"],
                        expires_at=(
                            datetime.fromisoformat(key_data["expires_at"])
                            if key_data["expires_at"]
                            else None
                        ),
                        last_used_at=(
                            datetime.fromisoformat(key_data["last_used_at"])
                            if key_data["last_used_at"]
                            else None
                        ),
                        created_at=datetime.fromisoformat(key_data["created_at"]),
                    )
                )

            return api_keys

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
            client = await self.db.client
            result = (
                await client.table("api_keys")
                .update({"status": APIKeyStatus.REVOKED})
                .eq("key_id", str(key_id))
                .eq("account_id", str(account_id))
                .execute()
            )

            if not result.data:
                raise HTTPException(status_code=404, detail="API key not found")

            logger.debug(
                "API key revoked successfully",
                account_id=str(account_id),
                key_id=str(key_id),
            )

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
                redis_client = await redis.get_client()
                cached_result = await redis_client.get(cache_key)
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

            client = await self.db.client

            # Single optimized query with join to get user info
            result = (
                await client.table("api_keys")
                .select("key_id, account_id, status, expires_at, secret_key_hash")
                .eq("public_key", public_key)
                .execute()
            )

            if not result.data:
                validation_result = APIKeyValidationResult(
                    is_valid=False, error_message="API key not found"
                )
                await self._cache_validation_result(
                    cache_key, validation_result, ttl=300
                )  # Cache negative results for 5 min
                return validation_result

            key_data = result.data[0]

            # Check if key is expired first (faster than status check)
            if key_data["expires_at"]:
                expires_at = datetime.fromisoformat(key_data["expires_at"])
                if expires_at < datetime.now(timezone.utc):
                    validation_result = APIKeyValidationResult(
                        is_valid=False, error_message="API key expired"
                    )
                    await self._cache_validation_result(
                        cache_key, validation_result, ttl=3600
                    )  # Cache expired for 1 hour
                    return validation_result

            # Check if key is active
            if key_data["status"] != APIKeyStatus.ACTIVE:
                validation_result = APIKeyValidationResult(
                    is_valid=False, error_message=f"API key is {key_data['status']}"
                )
                await self._cache_validation_result(
                    cache_key, validation_result, ttl=3600
                )  # Cache inactive for 1 hour
                return validation_result

            # Verify the secret key against the stored hash
            if not self._verify_secret_key(secret_key, key_data["secret_key_hash"]):
                validation_result = APIKeyValidationResult(
                    is_valid=False, error_message="Invalid secret key"
                )
                await self._cache_validation_result(
                    cache_key, validation_result, ttl=300
                )  # Cache invalid for 5 min
                return validation_result

            # Success case
            validation_result = APIKeyValidationResult(
                is_valid=True,
                account_id=UUID(key_data["account_id"]),
                key_id=UUID(key_data["key_id"]),
            )

            # Cache successful validation for 2 minutes
            await self._cache_validation_result(cache_key, validation_result, ttl=120)

            # Update last used timestamp with throttling to prevent DB spam
            # (max once per 15 minutes per key, configurable via config.API_KEY_LAST_USED_THROTTLE_SECONDS)
            asyncio.create_task(self._update_last_used_throttled(key_data["key_id"]))

            return validation_result

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
            redis_client = await redis.get_client()
            import json

            cache_data = {
                "is_valid": result.is_valid,
                "account_id": str(result.account_id) if result.account_id else None,
                "key_id": str(result.key_id) if result.key_id else None,
                "error_message": result.error_message,
            }
            await redis_client.setex(cache_key, ttl, json.dumps(cache_data))
        except Exception as e:
            logger.warning(f"Failed to cache validation result: {e}")

    async def _update_last_used_throttled(self, key_id: str):
        """Update last used timestamp with throttling to reduce DB load"""
        throttle_interval = config.API_KEY_LAST_USED_THROTTLE_SECONDS
        current_time = time.time()

        # Try Redis first
        try:
            redis_client = await redis.get_client()
            throttle_key = f"last_used_throttle:{key_id}"

            # Check if we've updated this key recently
            last_update = await redis_client.get(throttle_key)
            if last_update:
                # Already updated within throttle interval, skip
                return

            # Set throttle flag first to prevent race conditions
            await redis_client.setex(throttle_key, throttle_interval, "1")

        except Exception as redis_error:
            # Fallback to in-memory throttling when Redis unavailable
            logger.debug(
                f"Redis unavailable for throttling, using in-memory fallback: {redis_error}"
            )

            # Clean up old entries (simple cleanup every 100 operations)
            if len(self._throttle_cache) > 1000:
                cutoff_time = current_time - (
                    throttle_interval * 2
                )  # Keep extra buffer
                self._throttle_cache = {
                    k: v for k, v in self._throttle_cache.items() if v > cutoff_time
                }

            # Check in-memory throttle
            last_update_time = self._throttle_cache.get(key_id, 0)
            if current_time - last_update_time < throttle_interval:
                # Already updated within throttle interval, skip
                return

            # Set in-memory throttle
            self._throttle_cache[key_id] = current_time

        # Update database
        try:
            client = await self.db.client
            await client.table("api_keys").update(
                {"last_used_at": datetime.now(timezone.utc).isoformat()}
            ).eq("key_id", key_id).execute()

            logger.debug(f"Updated last_used_at for key {key_id}")

        except Exception as e:
            logger.warning(f"Failed to update last_used_at for key {key_id}: {e}")

    async def _update_last_used_async(self, key_id: str):
        """Legacy method - kept for backwards compatibility"""
        await self._update_last_used_throttled(key_id)

    async def _clear_throttle(self, key_id: str):
        """Clear the throttle for a specific key (useful for testing)"""
        try:
            redis_client = await redis.get_client()
            throttle_key = f"last_used_throttle:{key_id}"
            await redis_client.delete(throttle_key)
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
            client = await self.db.client
            result = (
                await client.table("api_keys")
                .delete()
                .eq("key_id", str(key_id))
                .eq("account_id", str(account_id))
                .execute()
            )

            if not result.data:
                raise HTTPException(status_code=404, detail="API key not found")

            logger.debug(
                "API key deleted successfully",
                account_id=str(account_id),
                key_id=str(key_id),
            )

            return True

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error deleting API key: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail="Failed to delete API key")
