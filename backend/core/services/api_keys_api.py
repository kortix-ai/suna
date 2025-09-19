"""
API Keys API Endpoints

This module provides REST API endpoints for managing API keys:
- POST /api/api-keys - Create a new API key
- GET /api/api-keys - List all API keys for the authenticated user
- DELETE /api/api-keys/{key_id} - Revoke/delete an API key
"""

from fastapi import APIRouter, Depends, HTTPException
from typing import List
from uuid import UUID

from core.services.api_keys import (
    APIKeyService,
    APIKeyCreateRequest,
    APIKeyResponse,
    APIKeyCreateResponse,
)
from core.services.supabase import DBConnection
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger

router = APIRouter()


async def get_api_key_service() -> APIKeyService:
    """Dependency to get API key service instance"""
    db = DBConnection()
    await db.initialize()
    return APIKeyService(db)


async def get_account_id_from_user_id(user_id: str) -> UUID:
    """Get account ID from user ID using basejump accounts table"""
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client

        # Query the basejump.accounts table for the user's primary account
        result = (
            await client.schema("basejump")
            .table("accounts")
            .select("id")
            .eq("primary_owner_user_id", user_id)
            .eq("personal_account", True)  # Get the user's personal account
            .limit(1)
            .execute()
        )

        if not result.data:
            raise HTTPException(status_code=404, detail="User account not found")

        return UUID(result.data[0]["id"])
    except Exception as e:
        logger.error(f"Error getting account ID: {e}")
        raise HTTPException(status_code=500, detail="Failed to get user account")


@router.post("/api-keys", response_model=APIKeyCreateResponse)
async def create_api_key(
    request: APIKeyCreateRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    api_key_service: APIKeyService = Depends(get_api_key_service),
):
    """
    Create a new API key for the authenticated user

    Args:
        request: API key creation request with title, description, and expiration
        user_id: Authenticated user ID from JWT or API key
        api_key_service: API key service instance

    Returns:
        APIKeyCreateResponse: The newly created API key details including the key value
    """
    try:
        account_id = await get_account_id_from_user_id(user_id)

        logger.debug(
            "Creating API key",
            user_id=user_id,
            account_id=str(account_id),
            title=request.title,
        )

        api_key = await api_key_service.create_api_key(account_id, request)

        logger.debug(
            "API key created successfully",
            user_id=user_id,
            key_id=str(api_key.key_id),
            title=api_key.title,
        )

        return api_key

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error creating API key: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to create API key")


@router.get("/api-keys", response_model=List[APIKeyResponse])
async def list_api_keys(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    api_key_service: APIKeyService = Depends(get_api_key_service),
):
    """
    List all API keys for the authenticated user

    Args:
        user_id: Authenticated user ID from JWT or API key
        api_key_service: API key service instance

    Returns:
        List[APIKeyResponse]: List of API keys (without the actual key values)
    """
    try:
        account_id = await get_account_id_from_user_id(user_id)

        logger.debug("Listing API keys", user_id=user_id, account_id=str(account_id))

        api_keys = await api_key_service.list_api_keys(account_id)

        logger.debug(
            "API keys listed successfully", user_id=user_id, count=len(api_keys)
        )

        return api_keys

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error listing API keys: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to list API keys")


@router.patch("/api-keys/{key_id}/revoke")
async def revoke_api_key(
    key_id: UUID,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    api_key_service: APIKeyService = Depends(get_api_key_service),
):
    """
    Revoke an API key

    Args:
        key_id: The ID of the API key to revoke
        user_id: Authenticated user ID from JWT or API key
        api_key_service: API key service instance

    Returns:
        dict: Success message
    """
    try:
        account_id = await get_account_id_from_user_id(user_id)

        logger.debug(
            "Revoking API key",
            user_id=user_id,
            account_id=str(account_id),
            key_id=str(key_id),
        )

        success = await api_key_service.revoke_api_key(account_id, key_id)

        if success:
            logger.debug(
                "API key revoked successfully", user_id=user_id, key_id=str(key_id)
            )
            return {"message": "API key revoked successfully"}
        else:
            raise HTTPException(status_code=500, detail="Failed to revoke API key")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error revoking API key: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to revoke API key")


@router.delete("/api-keys/{key_id}")
async def delete_api_key(
    key_id: UUID,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    api_key_service: APIKeyService = Depends(get_api_key_service),
):
    """
    Permanently delete an API key

    Args:
        key_id: The ID of the API key to delete
        user_id: Authenticated user ID from JWT or API key
        api_key_service: API key service instance

    Returns:
        dict: Success message
    """
    try:
        account_id = await get_account_id_from_user_id(user_id)

        logger.debug(
            "Deleting API key",
            user_id=user_id,
            account_id=str(account_id),
            key_id=str(key_id),
        )

        success = await api_key_service.delete_api_key(account_id, key_id)

        if success:
            logger.debug(
                "API key deleted successfully", user_id=user_id, key_id=str(key_id)
            )
            return {"message": "API key deleted successfully"}
        else:
            raise HTTPException(status_code=500, detail="Failed to delete API key")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error deleting API key: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete API key")
