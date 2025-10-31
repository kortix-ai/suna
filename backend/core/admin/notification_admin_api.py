"""
Admin Notification API
Handles admin operations for sending global notifications to users.
"""

from fastapi import APIRouter, HTTPException, Depends, Query, BackgroundTasks
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone
from pydantic import BaseModel, EmailStr
from core.auth import require_admin
from core.services.supabase import DBConnection
from core.services.notification_service import notification_service
from core.utils.logger import logger

router = APIRouter(prefix="/admin/notifications", tags=["admin-notifications"])

# ============================================================================
# MODELS
# ============================================================================

class GlobalNotificationRequest(BaseModel):
    title: str
    message: str
    notification_type: str = "info"  # info, success, warning, error
    send_email: bool = True
    send_push: bool = True
    target_account_ids: Optional[List[str]] = None  # None means all users
    target_user_ids: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None

class GlobalNotificationBatch(BaseModel):
    """Track a batch of global notifications in notifications table"""
    batch_id: str
    created_by: str
    title: str
    message: str
    type: str
    send_email: bool
    send_push: bool
    target_account_ids: Optional[List[str]] = None
    target_user_ids: Optional[List[str]] = None
    status: str  # pending, sending, completed, failed
    total_recipients: int
    emails_sent: int
    pushes_sent: int
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    created_at: str

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def send_notification_to_users(
    batch_id: str,
    created_by: str,
    target_account_ids: Optional[List[str]],
    target_user_ids: Optional[List[str]],
    title: str,
    message: str,
    notification_type: str,
    send_email: bool,
    send_push: bool,
    metadata: Optional[Dict[str, Any]]
):
    """Background task to send notifications to all target users."""
    batch_metadata = {
        'batch_id': batch_id,
        'status': 'sending',
        'started_at': datetime.now(timezone.utc).isoformat(),
        'emails_sent': 0,
        'pushes_sent': 0,
        'total_recipients': 0
    }
    
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        # Get target users and their account_ids
        user_account_map = {}
        
        if target_user_ids:
            # Send to specific users
            for user_id in target_user_ids:
                account_query = await client.schema('basejump').from_('accounts').select('id').eq('primary_owner_user_id', user_id).eq('personal_account', True).limit(1).execute()
                if account_query.data:
                    user_account_map[user_id] = account_query.data[0]['id']
        elif target_account_ids:
            # Send to users in specific accounts
            accounts_query = await client.schema('basejump').from_('accounts').select('id, primary_owner_user_id').in_('id', target_account_ids).execute()
            if accounts_query.data:
                for account in accounts_query.data:
                    user_id = account.get('primary_owner_user_id')
                    if user_id:
                        user_account_map[user_id] = account['id']
        else:
            # Send to all users (get all account owners)
            accounts_query = await client.schema('basejump').from_('accounts').select('id, primary_owner_user_id').eq('personal_account', True).execute()
            if accounts_query.data:
                for account in accounts_query.data:
                    user_id = account.get('primary_owner_user_id')
                    if user_id:
                        user_account_map[user_id] = account['id']
        
        total_recipients = len(user_account_map)
        emails_sent = 0
        pushes_sent = 0
        
        if total_recipients == 0:
            logger.warning(f"No recipients found for global notification '{title}'. Check if users exist in basejump.accounts table.")
            batch_metadata['status'] = 'failed'
            batch_metadata['error'] = 'No recipients found'
            batch_metadata['total_recipients'] = 0
            return
        
        logger.info(f"Sending global notification '{title}' to {total_recipients} users")
        
        batch_metadata['total_recipients'] = total_recipients
        
        # Store batch status in a special tracking notification (for cancellation checks)
        # Create a "sentinel" notification record to track batch status
        # Get admin's account_id for the tracking notification
        admin_account_result = await client.schema('basejump').from_('accounts').select('id').eq('primary_owner_user_id', created_by).eq('personal_account', True).limit(1).execute()
        admin_account_id = admin_account_result.data[0]['id'] if admin_account_result.data else None
        
        tracking_notification = await client.table('notifications').insert({
            'account_id': admin_account_id,  # Admin's account for tracking
            'user_id': created_by,  # Admin who created it
            'title': f'[BATCH_TRACKING] {title}',
            'message': 'Batch tracking record - do not display to users',
            'type': 'info',
            'category': 'admin',
            'is_global': True,
            'created_by': created_by,
            'metadata': {
                'batch_id': batch_id,
                'batch_status': 'sending',
                'total_recipients': total_recipients,
                'emails_sent': 0,
                'pushes_sent': 0,
                'is_batch_tracker': True  # Special flag to identify this as a tracking record
            },
            'email_sent': False,
            'push_sent': False,
            'is_read': True  # Mark as read so it doesn't show in user notifications
        }).execute()
        
        tracking_notification_id = tracking_notification.data[0]['id'] if tracking_notification.data else None
        
        # Batch processing with rate limiting (100 users at a time, 0.1s delay)
        import asyncio
        user_items = list(user_account_map.items())
        batch_size = 100
        
        for i in range(0, len(user_items), batch_size):
            # Check if batch was cancelled
            if tracking_notification_id:
                check_status = await client.table('notifications').select('metadata').eq('id', tracking_notification_id).execute()
                if check_status.data:
                    metadata = check_status.data[0].get('metadata', {})
                    if metadata.get('batch_status') == 'cancelled':
                        logger.info(f"Batch {batch_id} was cancelled. Stopping at user {i}/{len(user_items)}")
                        batch_metadata['status'] = 'cancelled'
                        batch_metadata['emails_sent'] = emails_sent
                        batch_metadata['pushes_sent'] = pushes_sent
                        batch_metadata['cancelled_at'] = datetime.now(timezone.utc).isoformat()
                        # Update tracking notification
                        await client.table('notifications').update({
                            'metadata': {
                                **metadata,
                                'batch_status': 'cancelled',
                                'emails_sent': emails_sent,
                                'pushes_sent': pushes_sent,
                                'cancelled_at': datetime.now(timezone.utc).isoformat()
                            }
                        }).eq('id', tracking_notification_id).execute()
                        return
            
            batch = user_items[i:i + batch_size]
            
            # Send notifications in batch
            for user_id, account_id in batch:
                try:
                    # Send notification (mark as global)
                    result = await notification_service.send_notification(
                        user_id=user_id,
                        account_id=account_id,
                        title=title,
                        message=message,
                        notification_type=notification_type,
                        category="admin",
                        send_email=send_email,
                        send_push=send_push,
                        metadata={
                            **(metadata or {}),
                            'global_batch_id': batch_id,
                            'created_by': created_by
                        }
                    )
                    
                    # Also mark notification as global
                    if result.get('notification_id'):
                        await client.table('notifications').update({
                            'is_global': True,
                            'created_by': created_by
                        }).eq('id', result['notification_id']).execute()
                    
                    if result.get('email_sent'):
                        emails_sent += 1
                    if result.get('push_sent'):
                        pushes_sent += 1
                    
                    # Update tracking notification periodically (every 10 users)
                    if (emails_sent + pushes_sent) % 10 == 0 and tracking_notification_id:
                        await client.table('notifications').update({
                            'metadata': {
                                'batch_id': batch_id,
                                'batch_status': 'sending',
                                'total_recipients': total_recipients,
                                'emails_sent': emails_sent,
                                'pushes_sent': pushes_sent,
                                'is_batch_tracker': True
                            }
                        }).eq('id', tracking_notification_id).execute()
                        
                except Exception as e:
                    logger.error(f"Error sending notification to user {user_id}: {str(e)}")
                    continue
            
            # Rate limiting: wait between batches
            if i + batch_size < len(user_items):
                await asyncio.sleep(0.1)
        
        # Update final tracking notification
        if tracking_notification_id:
            await client.table('notifications').update({
                'metadata': {
                    'batch_id': batch_id,
                    'batch_status': 'completed',
                    'total_recipients': total_recipients,
                    'emails_sent': emails_sent,
                    'pushes_sent': pushes_sent,
                    'is_batch_tracker': True
                }
            }).eq('id', tracking_notification_id).execute()
        
        if batch_metadata.get('status') != 'cancelled':
            batch_metadata['status'] = 'completed'
            batch_metadata['emails_sent'] = emails_sent
            batch_metadata['pushes_sent'] = pushes_sent
            batch_metadata['completed_at'] = datetime.now(timezone.utc).isoformat()
            
            logger.info(f"Global notification '{title}' completed: {emails_sent} emails, {pushes_sent} pushes sent")
        
    except Exception as e:
        logger.error(f"Error in send_notification_to_users background task: {str(e)}")
        batch_metadata['status'] = 'failed'
        batch_metadata['error'] = str(e)
        
        # Update tracking notification on error
        try:
            if 'tracking_notification_id' in locals() and tracking_notification_id:
                await client.table('notifications').update({
                    'metadata': {
                        'batch_id': batch_id,
                        'batch_status': 'failed',
                        'error': str(e),
                        'is_batch_tracker': True
                    }
                }).eq('id', tracking_notification_id).execute()
        except:
            pass  # Don't fail on tracking update failure

# ============================================================================
# ADMIN NOTIFICATION ENDPOINTS
# ============================================================================

@router.post("/send-global", summary="Send Global Notification")
async def send_global_notification(
    request: GlobalNotificationRequest,
    background_tasks: BackgroundTasks,
    admin: dict = Depends(require_admin)
):
    """Send a global notification to all users or specific target users."""
    try:
        import uuid
        db = DBConnection()
        await db.initialize()
        
        # Get admin user_id from JWT
        admin_user_id = admin.get('user_id') or admin.get('sub')
        
        if not admin_user_id:
            raise HTTPException(status_code=400, detail="Admin user ID not found in token")
        
        # Create batch ID to track this global notification
        batch_id = str(uuid.uuid4())
        
        # Store batch info in a simple tracking mechanism
        # We'll use a notifications entry with is_global=True as the batch record
        # Or store in metadata of the first notification
        
        # Schedule background task to send notifications
        background_tasks.add_task(
            send_notification_to_users,
            batch_id,
            admin_user_id,
            request.target_account_ids,
            request.target_user_ids,
            request.title,
            request.message,
            request.notification_type,
            request.send_email,
            request.send_push,
            request.metadata
        )
        
        return {
            'batch_id': batch_id,
            'status': 'pending',
            'message': 'Global notification queued for sending',
            'title': request.title
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error sending global notification: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to send global notification")


@router.get("/list", summary="List Global Notification Batches")
async def list_global_notifications(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    admin: dict = Depends(require_admin)
):
    """List all global notification batches by aggregating notifications table."""
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        # Get unique global batches by grouping notifications with same batch_id
        # We'll get the first notification of each batch to show batch info
        query = client.table('notifications').select('*').eq('is_global', True).order('created_at', desc=True)
        
        # Paginate
        offset = (page - 1) * page_size
        query = query.range(offset, offset + page_size - 1)
        
        result = await query.execute()
        
        # Group by batch_id and aggregate stats
        # First, find all tracking notifications to get batch status
        tracking_notifications = {}
        batches = {}
        
        if result.data:
            # First pass: collect tracking notifications and regular notifications
            for notif in result.data:
                metadata = notif.get('metadata', {})
                
                # Handle case where metadata might be a string (Supabase JSONB can return as string)
                if isinstance(metadata, str):
                    import json
                    try:
                        metadata = json.loads(metadata)
                    except (json.JSONDecodeError, TypeError):
                        logger.warning(f"Failed to parse metadata as JSON in list: {metadata}")
                        metadata = {}
                
                if metadata.get('is_batch_tracker'):
                    # This is a tracking notification
                    batch_id = metadata.get('batch_id')
                    if batch_id:
                        tracking_notifications[batch_id] = {
                            'batch_id': batch_id,
                            'status': metadata.get('batch_status', 'completed'),
                            'total_recipients': metadata.get('total_recipients', 0),
                            'emails_sent': metadata.get('emails_sent', 0),
                            'pushes_sent': metadata.get('pushes_sent', 0),
                            'started_at': metadata.get('started_at'),
                            'completed_at': metadata.get('completed_at'),
                            'cancelled_at': metadata.get('cancelled_at'),
                            'title': notif.get('title', '').replace('[BATCH_TRACKING] ', ''),  # Remove tracking prefix
                            'created_by': notif.get('created_by'),
                            'type': notif.get('type'),
                            'created_at': notif.get('created_at')
                        }
                else:
                    # Regular notification
                    batch_id = metadata.get('global_batch_id')
                    if batch_id:
                        if batch_id not in batches:
                            batches[batch_id] = {
                                'batch_id': batch_id,
                                'created_by': notif.get('created_by'),
                                'title': notif.get('title'),
                                'message': notif.get('message'),
                                'type': notif.get('type'),
                                'created_at': notif.get('created_at'),
                                'total_count': 0,
                                'emails_sent_count': 0,
                                'pushes_sent_count': 0
                            }
                        batches[batch_id]['total_count'] += 1
                        if notif.get('email_sent'):
                            batches[batch_id]['emails_sent_count'] += 1
                        if notif.get('push_sent'):
                            batches[batch_id]['pushes_sent_count'] += 1
            
            # Merge tracking data into batches
            for batch_id, tracking_data in tracking_notifications.items():
                if batch_id in batches:
                    batches[batch_id].update({
                        'status': tracking_data['status'],
                        'total_recipients': tracking_data['total_recipients'],
                        'started_at': tracking_data['started_at'],
                        'completed_at': tracking_data['completed_at'],
                        'cancelled_at': tracking_data['cancelled_at']
                    })
                else:
                    # Batch exists only as tracking notification (no users processed yet or all filtered out)
                    batches[batch_id] = {
                        'batch_id': batch_id,
                        'title': tracking_data['title'],
                        'message': 'Batch tracking',
                        'type': tracking_data['type'],
                        'created_by': tracking_data['created_by'],
                        'status': tracking_data['status'],
                        'total_recipients': tracking_data['total_recipients'],
                        'emails_sent_count': tracking_data['emails_sent'],
                        'pushes_sent_count': tracking_data['pushes_sent'],
                        'total_count': 0,
                        'created_at': tracking_data['created_at'],
                        'started_at': tracking_data['started_at'],
                        'completed_at': tracking_data['completed_at'],
                        'cancelled_at': tracking_data['cancelled_at']
                    }
        
        return list(batches.values())
        
    except Exception as e:
        logger.error(f"Error listing global notifications: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to list global notifications")


@router.get("/batch/{batch_id}", summary="Get Global Notification Batch Details")
async def get_global_notification_batch(
    batch_id: str,
    admin: dict = Depends(require_admin)
):
    """Get details of a specific global notification batch."""
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        logger.debug(f"Searching for batch_id: {batch_id}")
        
        # Query for tracking and user notifications
        # Since Supabase Python client may not support JSONB operators directly,
        # we'll fetch all global notifications and filter client-side
        # But we'll limit to a reasonable number to avoid performance issues
        tracking_notif = None
        user_notifications = []
        
        # Try using JSONB filter first (PostgREST syntax)
        try:
            # Query for tracking notification
            tracking_result = await client.table('notifications').select('*').eq('is_global', True).eq('metadata->>batch_id', batch_id).limit(100).execute()
            
            if tracking_result.data:
                for notif in tracking_result.data:
                    metadata = notif.get('metadata', {})
                    
                    # Handle case where metadata might be a string
                    if isinstance(metadata, str):
                        import json
                        try:
                            metadata = json.loads(metadata)
                        except (json.JSONDecodeError, TypeError):
                            logger.warning(f"Failed to parse tracking metadata as JSON")
                            continue
                    
                    if isinstance(metadata, dict) and metadata.get('is_batch_tracker'):
                        tracking_notif = notif
                        logger.debug(f"Found tracking notification for batch {batch_id}")
                        break
            
            # Query for user notifications
            user_result = await client.table('notifications').select('*').eq('is_global', True).eq('metadata->>global_batch_id', batch_id).limit(1000).execute()
            
            if user_result.data:
                user_notifications = list(user_result.data)
                logger.debug(f"Found {len(user_notifications)} user notifications for batch {batch_id} via JSONB filter")
        except Exception as e:
            # Fallback: Fetch all global notifications and filter client-side
            logger.debug(f"JSONB filter failed, falling back to client-side filtering: {e}")
            
            # Fetch in batches to handle large datasets
            offset = 0
            limit = 1000
            all_processed = False
            
            while not all_processed:
                result = await client.table('notifications').select('*').eq('is_global', True).range(offset, offset + limit - 1).execute()
                
                if not result.data or len(result.data) == 0:
                    all_processed = True
                    break
                
                for notif in result.data:
                    metadata = notif.get('metadata', {})
                    
                    # Handle case where metadata might be a string
                    if isinstance(metadata, str):
                        import json
                        try:
                            metadata = json.loads(metadata)
                        except (json.JSONDecodeError, TypeError):
                            continue
                    
                    if isinstance(metadata, dict):
                        # Check for tracking notification
                        if metadata.get('batch_id') == batch_id and metadata.get('is_batch_tracker') and not tracking_notif:
                            tracking_notif = notif
                            logger.debug(f"Found tracking notification for batch {batch_id}")
                        
                        # Check for user notifications
                        if metadata.get('global_batch_id') == batch_id:
                            user_notifications.append(notif)
                
                # If we got fewer results than limit, we've reached the end
                if len(result.data) < limit:
                    all_processed = True
                else:
                    offset += limit
                
                # Safety: stop after checking a reasonable number of records
                if offset >= 10000:  # Max 10k records
                    logger.warning(f"Reached max records limit (10k) while searching for batch {batch_id}")
                    break
            
            logger.debug(f"Found {len(user_notifications)} user notifications for batch {batch_id} via client-side filtering")
        
        logger.debug(f"Tracking notification found: {tracking_notif is not None}")
        logger.debug(f"User notifications found: {len(user_notifications)}")
        
        # If neither tracking nor user notifications found, batch doesn't exist
        if not tracking_notif and not user_notifications:
            logger.warning(f"Batch {batch_id} not found - no tracking or user notifications")
            raise HTTPException(status_code=404, detail="Global notification batch not found")
        
        # Use tracking notification for batch metadata (if available), otherwise use first user notification
        if tracking_notif:
            tracking_metadata = tracking_notif.get('metadata', {})
            
            # Handle case where metadata might be a string
            if isinstance(tracking_metadata, str):
                import json
                try:
                    tracking_metadata = json.loads(tracking_metadata)
                except (json.JSONDecodeError, TypeError):
                    logger.warning(f"Failed to parse tracking metadata as JSON")
                    tracking_metadata = {}
            
            batch_status = tracking_metadata.get('batch_status', 'pending')
            total_recipients = tracking_metadata.get('total_recipients', len(user_notifications))
            emails_sent_tracking = tracking_metadata.get('emails_sent', 0)
            pushes_sent_tracking = tracking_metadata.get('pushes_sent', 0)
            started_at = tracking_metadata.get('started_at')
            completed_at = tracking_metadata.get('completed_at')
            cancelled_at = tracking_metadata.get('cancelled_at')
            
            # Get title from tracking notification (remove [BATCH_TRACKING] prefix)
            title = tracking_notif.get('title', '').replace('[BATCH_TRACKING] ', '').strip()
            message = 'Batch tracking record'  # Tracking notifications have a generic message
            notif_type = tracking_notif.get('type')
            created_by = tracking_notif.get('created_by')
            created_at = tracking_notif.get('created_at')
        else:
            # Fallback to first user notification if tracking doesn't exist
            first_notif = user_notifications[0] if user_notifications else None
            if not first_notif:
                raise HTTPException(status_code=404, detail="Global notification batch not found")
            
            batch_status = 'completed'  # Default status
            total_recipients = len(user_notifications)
            emails_sent_tracking = 0
            pushes_sent_tracking = 0
            started_at = None
            completed_at = None
            cancelled_at = None
            title = first_notif.get('title')
            message = first_notif.get('message')
            notif_type = first_notif.get('type')
            created_by = first_notif.get('created_by')
            created_at = first_notif.get('created_at')
        
        # Count actual emails/pushes sent from user notifications
        emails_sent = sum(1 for n in user_notifications if n.get('email_sent'))
        pushes_sent = sum(1 for n in user_notifications if n.get('push_sent'))
        
        # Prefer tracking counts if available (more accurate during sending)
        if tracking_notif and batch_status in ['sending', 'pending']:
            emails_sent = emails_sent_tracking
            pushes_sent = pushes_sent_tracking
        
        return {
            'batch_id': batch_id,
            'created_by': created_by,
            'title': title,
            'message': message,
            'type': notif_type,
            'created_at': created_at,
            'status': batch_status,
            'total_recipients': total_recipients,
            'emails_sent': emails_sent,
            'pushes_sent': pushes_sent,
            'started_at': started_at,
            'completed_at': completed_at,
            'cancelled_at': cancelled_at,
            'notifications': user_notifications[:10]  # Return first 10 user notifications for preview
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching global notification batch: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch global notification batch")


@router.post("/batch/{batch_id}/cancel", summary="Cancel Global Notification Batch")
async def cancel_global_notification_batch(
    batch_id: str,
    admin: dict = Depends(require_admin)
):
    """Cancel a global notification batch that is currently sending."""
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        # Find the tracking notification for this batch
        result = await client.table('notifications').select('*').eq('is_global', True).execute()
        
        tracking_notif = None
        if result.data:
            for notif in result.data:
                metadata = notif.get('metadata', {})
                if isinstance(metadata, dict) and metadata.get('batch_id') == batch_id and metadata.get('is_batch_tracker'):
                    tracking_notif = notif
                    break
        
        if not tracking_notif:
            raise HTTPException(status_code=404, detail="Global notification batch not found")
        
        # Check current status
        metadata = tracking_notif.get('metadata', {})
        current_status = metadata.get('batch_status', 'unknown')
        
        if current_status not in ['pending', 'sending']:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot cancel batch with status '{current_status}'. Only 'pending' or 'sending' batches can be cancelled."
            )
        
        # Update tracking notification to mark as cancelled
        updated_metadata = {
            **metadata,
            'batch_status': 'cancelled',
            'cancelled_at': datetime.now(timezone.utc).isoformat(),
            'cancelled_by': admin.get('user_id') or admin.get('sub')
        }
        
        await client.table('notifications').update({
            'metadata': updated_metadata
        }).eq('id', tracking_notif['id']).execute()
        
        logger.info(f"Batch {batch_id} cancelled by admin {admin.get('user_id')}")
        
        return {
            'batch_id': batch_id,
            'status': 'cancelled',
            'message': 'Batch cancellation requested. Processing will stop at next checkpoint.'
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cancelling global notification batch: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to cancel global notification batch")
