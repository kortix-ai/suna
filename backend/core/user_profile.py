from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from pydantic import BaseModel
from typing import Optional, Tuple, Any

from core.services.supabase import DBConnection
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.utils.s3_upload_utils import upload_user_profile_picture


router = APIRouter(tags=["user-profile"])

MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024  # 5MB
ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp"}
PROFILE_PICTURE_BUCKET = "user-profile-pictures"


class ProfilePictureResponse(BaseModel):
    success: bool
    profile_picture_url: Optional[str] = None


async def _get_user_metadata(client, user_id: str) -> Tuple[dict, Any]:
    user_response = await client.auth.admin.get_user_by_id(user_id)
    if not user_response or not user_response.user:
        raise HTTPException(status_code=404, detail="User not found")
    metadata = dict(user_response.user.user_metadata or {})
    return metadata, user_response


@router.get("/users/profile-picture", response_model=ProfilePictureResponse)
async def get_profile_picture(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
):
    db = DBConnection()
    client = await db.client

    metadata, _ = await _get_user_metadata(client, user_id)
    return ProfilePictureResponse(success=True, profile_picture_url=metadata.get("avatar_url"))


@router.post("/users/profile-picture", response_model=ProfilePictureResponse)
async def upload_profile_picture(
    file: UploadFile = File(...),
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
):
    if not file:
        raise HTTPException(status_code=400, detail="No file provided")

    content_type = (file.content_type or "").lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Please upload a PNG, JPG, or WEBP image.",
        )

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    if len(file_bytes) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="File is too large (max 5MB)")

    db = DBConnection()
    client = await db.client

    metadata, _ = await _get_user_metadata(client, user_id)
    previous_path = metadata.get("profile_picture_path")

    if previous_path:
        try:
            await client.storage.from_(PROFILE_PICTURE_BUCKET).remove([previous_path])
        except Exception as e:
            logger.warning(f"Failed to remove previous profile picture for user {user_id}: {e}")

    public_url, storage_path = await upload_user_profile_picture(
        user_id=user_id,
        image_bytes=file_bytes,
        content_type=content_type,
        bucket_name=PROFILE_PICTURE_BUCKET,
    )

    metadata["avatar_url"] = public_url
    metadata["profile_picture_path"] = storage_path

    await client.auth.admin.update_user_by_id(user_id, {"user_metadata": metadata})

    return ProfilePictureResponse(success=True, profile_picture_url=public_url)


@router.delete("/users/profile-picture", response_model=ProfilePictureResponse)
async def delete_profile_picture(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
):
    db = DBConnection()
    client = await db.client

    metadata, _ = await _get_user_metadata(client, user_id)
    previous_path = metadata.pop("profile_picture_path", None)
    metadata.pop("avatar_url", None)

    if previous_path:
        try:
            await client.storage.from_(PROFILE_PICTURE_BUCKET).remove([previous_path])
        except Exception as e:
            logger.warning(f"Failed to remove profile picture for user {user_id}: {e}")

    await client.auth.admin.update_user_by_id(user_id, {"user_metadata": metadata})

    return ProfilePictureResponse(success=True, profile_picture_url=None)

