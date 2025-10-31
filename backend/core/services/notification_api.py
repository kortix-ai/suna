from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel, EmailStr
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone
from core.services.notification_service import notification_service
from core.services.supabase import DBConnection
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger

router = APIRouter(tags=["notifications"])

# ============================================================================
# Request/Response Models
# ============================================================================

class NotificationResponse(BaseModel):
    id: str
    account_id: str
    user_id: str
    title: str
    message: str
    type: str
    category: Optional[str] = None
    thread_id: Optional[str] = None
    agent_run_id: Optional[str] = None
    metadata: Dict[str, Any] = {}
    email_sent: bool
    email_sent_at: Optional[str] = None
    push_sent: bool
    push_sent_at: Optional[str] = None
    is_read: bool
    read_at: Optional[str] = None
    created_at: str
    updated_at: str

class NotificationListResponse(BaseModel):
    notifications: List[NotificationResponse]
    total: int
    unread_count: int

class MarkReadRequest(BaseModel):
    is_read: bool = True

class NotificationPreferencesRequest(BaseModel):
    email_enabled: Optional[bool] = None
    push_enabled: Optional[bool] = None
    email_categories: Optional[Dict[str, bool]] = None
    push_categories: Optional[Dict[str, bool]] = None

class NotificationPreferencesResponse(BaseModel):
    user_id: str
    account_id: str
    email_enabled: bool
    push_enabled: bool
    email_categories: Dict[str, bool]
    push_categories: Dict[str, bool]
    push_token: Optional[str] = None
    push_token_updated_at: Optional[str] = None
    created_at: str
    updated_at: str

class RegisterPushTokenRequest(BaseModel):
    push_token: str

class SendNotificationRequest(BaseModel):
    user_id: str
    account_id: str
    title: str
    message: str
    notification_type: str = "info"
    category: Optional[str] = None
    thread_id: Optional[str] = None
    agent_run_id: Optional[str] = None
    send_email: bool = True
    send_push: bool = True
    metadata: Optional[Dict[str, Any]] = None

# ============================================================================
# Notification Endpoints
# ============================================================================

@router.get("/notifications", response_model=NotificationListResponse, summary="Get User Notifications")
async def get_notifications(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    is_read: Optional[bool] = Query(None, description="Filter by read status"),
    unread_only: bool = Query(False, description="Filter to unread notifications only (deprecated, use is_read=false)"),
    category: Optional[str] = Query(None, description="Filter by category"),
    notification_type: Optional[str] = Query(None, description="Filter by type"),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get notifications for the current user."""
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        # Build query - exclude batch tracking notifications from user view
        # First, get all user notifications with filters applied
        query = client.table('notifications').select('*').eq('user_id', user_id).order('created_at', desc=True)
        
        # Apply filters (prefer is_read parameter)
        if is_read is not None:
            query = query.eq('is_read', is_read)
        elif unread_only:
            query = query.eq('is_read', False)
        if category:
            query = query.eq('category', category)
        if notification_type:
            query = query.eq('type', notification_type)
        
        # Fetch all matching notifications (we'll filter batch tracking client-side)
        # Note: We fetch all to filter properly, but for performance we limit to reasonable amount
        result = await query.limit(1000).execute()
        
        logger.debug(f"Found {len(result.data) if result.data else 0} notifications for user {user_id} before filtering")
        
        # Filter out batch tracking notifications (internal tracking records)
        filtered_notifications = []
        if result.data:
            for notif in result.data:
                metadata = notif.get('metadata', {})
                
                # Handle case where metadata might be a string
                if isinstance(metadata, str):
                    import json
                    try:
                        metadata = json.loads(metadata)
                    except (json.JSONDecodeError, TypeError):
                        metadata = {}
                
                # Skip batch tracking notifications (they have is_batch_tracker: true in metadata)
                if isinstance(metadata, dict) and metadata.get('is_batch_tracker'):
                    continue
                
                # Also skip notifications with [BATCH_TRACKING] prefix in title (legacy check)
                if notif.get('title', '').startswith('[BATCH_TRACKING]'):
                    continue
                
                filtered_notifications.append(notif)
        
        logger.debug(f"Found {len(filtered_notifications)} notifications for user {user_id} after filtering out batch tracking")
        
        # Get total count (after filtering)
        total = len(filtered_notifications)
        
        # Paginate after filtering
        offset = (page - 1) * page_size
        paginated_notifications = filtered_notifications[offset:offset + page_size]
        
        notifications = []
        if paginated_notifications:
            notifications = [NotificationResponse(**notif) for notif in paginated_notifications]
        
        # Get unread count (excluding batch tracking) - re-query with proper filters
        unread_query = client.table('notifications').select('*').eq('user_id', user_id).eq('is_read', False)
        if category:
            unread_query = unread_query.eq('category', category)
        if notification_type:
            unread_query = unread_query.eq('type', notification_type)
        
        unread_result = await unread_query.limit(1000).execute()
        unread_filtered = []
        if unread_result.data:
            for notif in unread_result.data:
                metadata = notif.get('metadata', {})
                if isinstance(metadata, str):
                    import json
                    try:
                        metadata = json.loads(metadata)
                    except (json.JSONDecodeError, TypeError):
                        metadata = {}
                if isinstance(metadata, dict) and metadata.get('is_batch_tracker'):
                    continue
                if notif.get('title', '').startswith('[BATCH_TRACKING]'):
                    continue
                unread_filtered.append(notif)
        
        unread_count = len(unread_filtered)
        
        return NotificationListResponse(
            notifications=notifications,
            total=total,
            unread_count=unread_count
        )
        
    except Exception as e:
        logger.error(f"Error fetching notifications: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch notifications")


@router.get("/notifications/{notification_id}", response_model=NotificationResponse, summary="Get Notification")
async def get_notification(
    notification_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get a specific notification by ID."""
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        result = await client.table('notifications').select('*').eq('id', notification_id).eq('user_id', user_id).execute()
        
        if not result.data:
            raise HTTPException(status_code=404, detail="Notification not found")
        
        return NotificationResponse(**result.data[0])
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching notification: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch notification")


@router.patch("/notifications/{notification_id}/read", response_model=NotificationResponse, summary="Mark Notification as Read")
async def mark_notification_read(
    notification_id: str,
    request: MarkReadRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Mark a notification as read or unread."""
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        # Verify notification belongs to user
        check_result = await client.table('notifications').select('id').eq('id', notification_id).eq('user_id', user_id).execute()
        if not check_result.data:
            raise HTTPException(status_code=404, detail="Notification not found")
        
        # Update read status
        update_data = {'is_read': request.is_read}
        if request.is_read:
            update_data['read_at'] = datetime.now(timezone.utc).isoformat()
        else:
            update_data['read_at'] = None
        
        result = await client.table('notifications').update(update_data).eq('id', notification_id).execute()
        
        if not result.data:
            raise HTTPException(status_code=404, detail="Notification not found")
        
        return NotificationResponse(**result.data[0])
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating notification: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update notification")


class MarkNotificationsReadRequest(BaseModel):
    notification_ids: Optional[List[str]] = None
    is_read: bool = True

@router.patch("/notifications/read-all", summary="Mark Notifications as Read")
async def mark_notifications_read(
    request: Optional[MarkNotificationsReadRequest] = None,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Mark notifications as read. Supports marking all or specific notifications."""
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        # If request body provided, use it; otherwise default to None
        if request is None:
            request = MarkNotificationsReadRequest()
        
        # If specific IDs provided, mark only those
        if request.notification_ids and len(request.notification_ids) > 0:
            update_data = {
                'is_read': request.is_read,
                'read_at': datetime.now(timezone.utc).isoformat() if request.is_read else None
            }
            result = await client.table('notifications').update(update_data).eq('user_id', user_id).in_('id', request.notification_ids).execute()
        else:
            # Mark all unread notifications
            update_data = {
                'is_read': True,
                'read_at': datetime.now(timezone.utc).isoformat()
            }
            result = await client.table('notifications').update(update_data).eq('user_id', user_id).eq('is_read', False).execute()
        
        return {"success": True, "updated_count": len(result.data) if result.data else 0}
        
    except Exception as e:
        logger.error(f"Error marking notifications as read: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update notifications")

# ============================================================================
# Notification Preferences Endpoints
# ============================================================================

@router.get("/notifications/preferences", response_model=NotificationPreferencesResponse, summary="Get Notification Preferences")
async def get_notification_preferences(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get notification preferences for the current user."""
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        result = await client.table('user_notification_preferences').select('*').eq('user_id', user_id).execute()
        
        if not result.data:
            # Return default preferences
            default_categories = {"agent": True, "system": True, "billing": True, "admin": True}
            return NotificationPreferencesResponse(
                user_id=user_id,
                account_id="",
                email_enabled=True,
                push_enabled=True,
                email_categories=default_categories,
                push_categories=default_categories,
                push_token=None,
                push_token_updated_at=None,
                created_at=datetime.now(timezone.utc).isoformat(),
                updated_at=datetime.now(timezone.utc).isoformat()
            )
        
        prefs = result.data[0]
        return NotificationPreferencesResponse(**prefs)
        
    except Exception as e:
        logger.error(f"Error fetching notification preferences: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch notification preferences")


@router.put("/notifications/preferences", response_model=NotificationPreferencesResponse, summary="Update Notification Preferences")
async def update_notification_preferences(
    request: NotificationPreferencesRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Update notification preferences for the current user."""
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        # Get account_id from user
        account_result = await client.schema('basejump').from_('accounts').select('id').eq('primary_owner_user_id', user_id).execute()
        if not account_result.data:
            raise HTTPException(status_code=404, detail="Account not found")
        
        account_id = account_result.data[0]['id']
        
        # Build update data
        update_data = {}
        if request.email_enabled is not None:
            update_data['email_enabled'] = request.email_enabled
        if request.push_enabled is not None:
            update_data['push_enabled'] = request.push_enabled
        if request.email_categories is not None:
            update_data['email_categories'] = request.email_categories
        if request.push_categories is not None:
            update_data['push_categories'] = request.push_categories
        update_data['updated_at'] = datetime.now(timezone.utc).isoformat()
        
        # Check if preferences exist
        existing = await client.table('user_notification_preferences').select('user_id').eq('user_id', user_id).execute()
        
        if existing.data:
            # Update existing
            result = await client.table('user_notification_preferences').update(update_data).eq('user_id', user_id).execute()
        else:
            # Create new
            update_data['user_id'] = user_id
            update_data['account_id'] = account_id
            result = await client.table('user_notification_preferences').insert(update_data).execute()
        
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to update preferences")
        
        return NotificationPreferencesResponse(**result.data[0])
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating notification preferences: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update notification preferences")


@router.post("/notifications/register-push-token", summary="Register Push Notification Token")
async def register_push_token(
    request: RegisterPushTokenRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Register or update the push notification token for the current user."""
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        # Get account_id from user
        account_result = await client.schema('basejump').from_('accounts').select('id').eq('primary_owner_user_id', user_id).execute()
        if not account_result.data:
            raise HTTPException(status_code=404, detail="Account not found")
        
        account_id = account_result.data[0]['id']
        
        # Check if preferences exist
        existing = await client.table('user_notification_preferences').select('user_id').eq('user_id', user_id).execute()
        
        update_data = {
            'push_token': request.push_token,
            'push_token_updated_at': datetime.now(timezone.utc).isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        if existing.data:
            # Update existing
            result = await client.table('user_notification_preferences').update(update_data).eq('user_id', user_id).execute()
        else:
            # Create new
            update_data['user_id'] = user_id
            update_data['account_id'] = account_id
            result = await client.table('user_notification_preferences').insert(update_data).execute()
        
        return {"success": True, "message": "Push token registered successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error registering push token: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to register push token")

# ============================================================================
# Internal Send Notification Endpoint (for use by other services)
# ============================================================================

@router.post("/notifications/send", summary="Send Notification (Internal)")
async def send_notification_internal(
    request: SendNotificationRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Internal endpoint to send a notification. Used by agent tools and other services."""
    try:
        result = await notification_service.send_notification(
            user_id=request.user_id,
            account_id=request.account_id,
            title=request.title,
            message=request.message,
            notification_type=request.notification_type,
            category=request.category,
            thread_id=request.thread_id,
            agent_run_id=request.agent_run_id,
            send_email=request.send_email,
            send_push=request.send_push,
            metadata=request.metadata
        )
        
        return result
        
    except Exception as e:
        logger.error(f"Error sending notification: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to send notification")
