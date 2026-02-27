from fastapi import APIRouter, Depends, HTTPException, Request
from typing import Dict, List, Optional, Any
from pydantic import BaseModel
from core.auth import get_current_user
from core.utils.logger import logger
from core.utils.config import config, EnvMode
from .notification_service import notification_service
from .models import NotificationChannel, NotificationEvent, NotificationPriority

router = APIRouter(tags=["notifications"], prefix="/notifications")


def check_notifications_enabled():
    if config.ENV_MODE != EnvMode.STAGING:
        raise HTTPException(
            status_code=403, 
            detail=f"Notifications are only available in staging mode (current mode: {config.ENV_MODE.value})"
        )


class NotificationSettingsUpdate(BaseModel):
    email_enabled: Optional[bool] = None
    push_enabled: Optional[bool] = None
    in_app_enabled: Optional[bool] = None


class DeviceTokenRequest(BaseModel):
    device_token: str
    device_type: str = "mobile"
    provider: str = "expo"


class TestNotificationRequest(BaseModel):
    event_type: NotificationEvent = NotificationEvent.SYSTEM_ALERT
    channels: Optional[List[NotificationChannel]] = None
    title: str = "Test Notification"
    message: str = "This is a test notification from Kortix"


class SendNotificationRequest(BaseModel):
    account_id: str
    event_type: NotificationEvent
    data: Dict[str, Any]
    channels: Optional[List[NotificationChannel]] = None
    priority: NotificationPriority = NotificationPriority.MEDIUM


@router.get("/settings")
async def get_notification_settings(current_user: dict = Depends(get_current_user)):
    check_notifications_enabled()
    try:
        account_id = current_user.get('user_id')
        settings = await notification_service.get_account_notification_settings(account_id)
        
        if not settings:
            settings = await notification_service.create_default_settings(account_id)
        
        return {"success": True, "settings": settings.dict()}
        
    except Exception as e:
        logger.error(f"Error getting notification settings: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/settings")
async def update_notification_settings(
    settings_update: NotificationSettingsUpdate,
    current_user: dict = Depends(get_current_user)
):
    check_notifications_enabled()
    try:
        account_id = current_user.get('user_id')
        
        update_data = {k: v for k, v in settings_update.dict().items() if v is not None}
        
        success = await notification_service.update_account_notification_settings(
            account_id=account_id,
            settings=update_data
        )
        
        if not success:
            raise HTTPException(status_code=500, detail="Failed to update settings")
        
        updated_settings = await notification_service.get_account_notification_settings(account_id)
        
        return {
            "success": True,
            "message": "Notification settings updated successfully",
            "settings": updated_settings.dict() if updated_settings else None
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating notification settings: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/device-token")
async def register_device_token(
    token_request: DeviceTokenRequest,
    current_user: dict = Depends(get_current_user)
):
    check_notifications_enabled()
    try:
        account_id = current_user.get('user_id')
        
        success = await notification_service.register_device_token(
            account_id=account_id,
            device_token=token_request.device_token,
            device_type=token_request.device_type,
            provider=token_request.provider
        )
        
        if not success:
            raise HTTPException(status_code=500, detail="Failed to register device token")
        
        return {
            "success": True,
            "message": "Device token registered successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error registering device token: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/device-token/{device_token}")
async def unregister_device_token(
    device_token: str,
    provider: str = "expo",
    current_user: dict = Depends(get_current_user)
):
    check_notifications_enabled()
    try:
        account_id = current_user.get('user_id')
        
        success = await notification_service.unregister_device_token(
            account_id=account_id,
            device_token=device_token,
            provider=provider
        )
        
        if not success:
            raise HTTPException(status_code=500, detail="Failed to unregister device token")
        
        return {
            "success": True,
            "message": "Device token unregistered successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error unregistering device token: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/webhooks/novu")
async def handle_novu_webhook(request: Request):
    try:
        payload = await request.json()
        
        logger.info(f"Received Novu webhook: {payload.get('type', 'unknown')}")
        
        event_type = payload.get('type')
        
        if event_type == 'notification.sent':
            logger.info(f"Notification sent: {payload.get('transactionId')}")
        elif event_type == 'notification.failed':
            logger.warning(f"Notification failed: {payload.get('transactionId')}")
        elif event_type == 'subscriber.created':
            logger.info(f"Subscriber created: {payload.get('subscriberId')}")
        
        return {"status": "ok"}
        
    except Exception as e:
        logger.error(f"Error handling Novu webhook: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

