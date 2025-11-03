import os
import logging
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
from uuid import UUID
import httpx
from core.services.email import email_service
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.retry import retry

logger = logging.getLogger(__name__)


class NotificationService:
    """Service for sending notifications via email and push notifications."""
    
    def __init__(self):
        # Expo Push Notification credentials
        self.expo_api_url = os.getenv('EXPO_API_URL', 'https://exp.host/--/api/v2/push/send')
        
        # Email service is already initialized
        self.email_service = email_service
        
    async def send_notification(
        self,
        user_id: str,
        account_id: str,
        title: str,
        message: str,
        notification_type: str = "info",
        category: Optional[str] = None,
        thread_id: Optional[str] = None,
        agent_run_id: Optional[str] = None,
        send_email: bool = True,
        send_push: bool = True,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Send a notification to a user via email and/or push notification.
        
        Args:
            user_id: The user's ID
            account_id: The account ID
            title: Notification title
            message: Notification message
            notification_type: Type of notification (info, success, warning, error, agent_complete)
            category: Category of notification (agent, system, billing, admin)
            thread_id: Optional thread ID if related to a thread
            agent_run_id: Optional agent run ID if related to an agent run
            send_email: Whether to send email notification
            send_push: Whether to send push notification
            metadata: Optional metadata dictionary
            
        Returns:
            Dict with notification_id, email_sent, push_sent status
        """
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        try:
            # Get user notification preferences
            prefs_result = await client.table('user_notification_preferences').select('*').eq('user_id', user_id).execute()
            
            user_prefs = None
            if prefs_result.data and len(prefs_result.data) > 0:
                user_prefs = prefs_result.data[0]
            else:
                # Create default preferences
                await client.table('user_notification_preferences').insert({
                    'user_id': user_id,
                    'account_id': account_id
                }).execute()
                prefs_result = await client.table('user_notification_preferences').select('*').eq('user_id', user_id).execute()
                if prefs_result.data:
                    user_prefs = prefs_result.data[0]
            
            # Check preferences (simplified with JSONB categories)
            should_send_email = send_email and (user_prefs is None or user_prefs.get('email_enabled', True))
            should_send_push = send_push and (user_prefs is None or user_prefs.get('push_enabled', True))
            
            # Category-specific preferences (using JSONB)
            if user_prefs and category:
                email_categories = user_prefs.get('email_categories', {})
                push_categories = user_prefs.get('push_categories', {})
                
                # Default to True if category not specified in preferences
                should_send_email = should_send_email and email_categories.get(category, True)
                should_send_push = should_send_push and push_categories.get(category, True)
            
            # Create notification record
            notification_data = {
                'account_id': account_id,
                'user_id': user_id,
                'title': title,
                'message': message,
                'type': notification_type,
                'category': category,
                'thread_id': thread_id,
                'agent_run_id': agent_run_id,
                'metadata': metadata or {},
                'email_sent': False,
                'push_sent': False,
                'is_read': False
            }
            
            notification_result = await client.table('notifications').insert(notification_data).execute()
            
            if not notification_result.data:
                raise Exception("Failed to create notification record")
            
            notification_id = notification_result.data[0]['id']
            
            email_sent = False
            push_sent = False
            email_error = None
            push_error = None
            
            # Send email if enabled (with retry)
            if should_send_email:
                try:
                    # Get user email
                    user_email = await self._get_user_email(user_id, client)
                    
                    if user_email:
                        email_sent, email_error = await self._send_notification_email_with_retry(
                            user_email, title, message, notification_type, notification_id, client
                        )
                    else:
                        email_error = "Could not find email for user"
                        logger.warning(f"{email_error}: {user_id}")
                except Exception as e:
                    email_error = str(e)
                    logger.error(f"Error sending email notification: {str(e)}")
            
            # Send push notification if enabled (with retry and token validation)
            if should_send_push and user_prefs and user_prefs.get('push_token'):
                try:
                    push_token = user_prefs.get('push_token')
                    push_sent, push_error = await self._send_push_notification_with_retry(
                        push_token, title, message, notification_id, thread_id, agent_run_id, user_id, client
                    )
                except Exception as e:
                    push_error = str(e)
                    logger.error(f"Error sending push notification: {str(e)}")
            
            # Update notification with delivery status and errors
            update_data = {}
            if email_sent:
                update_data['email_sent'] = True
                update_data['email_sent_at'] = datetime.now(timezone.utc).isoformat()
                update_data['email_error'] = None
            elif email_error:
                update_data['email_error'] = email_error
            
            if push_sent:
                update_data['push_sent'] = True
                update_data['push_sent_at'] = datetime.now(timezone.utc).isoformat()
                update_data['push_error'] = None
            elif push_error:
                update_data['push_error'] = push_error
                # If token is invalid, mark it for refresh
                if 'DeviceNotRegistered' in push_error or 'InvalidCredentials' in push_error:
                    await self._mark_token_for_refresh(user_id, push_token, client)
            
            if update_data:
                update_data['retry_count'] = 0  # Reset on success
                await client.table('notifications').update(update_data).eq('id', notification_id).execute()
            
            return {
                'notification_id': notification_id,
                'email_sent': email_sent,
                'push_sent': push_sent
            }
            
        except Exception as e:
            logger.error(f"Error sending notification: {str(e)}")
            raise
    
    async def _get_user_email(self, user_id: str, client) -> Optional[str]:
        """Get user email with fallback methods."""
        # Try auth admin API first (recommended method)
        try:
            user_result = await client.auth.admin.get_user_by_id(user_id)
            if user_result and user_result.user:
                email = user_result.user.email
                if email:
                    return email
        except Exception as e:
            logger.debug(f"Failed to get user via auth.admin API for user {user_id}: {e}")
        
        # Fallback to RPC function
        try:
            user_email_result = await client.rpc('get_user_email', {'user_id': user_id}).execute()
            if user_email_result.data:
                return user_email_result.data
        except Exception as e:
            logger.debug(f"Failed to get email via RPC for user {user_id}: {e}")
        
        # Try billing_customers table as last resort
        try:
            # Get account_id first
            account_result = await client.schema('basejump').from_('accounts').select('id').eq('primary_owner_user_id', user_id).eq('personal_account', True).limit(1).execute()
            if account_result.data:
                account_id = account_result.data[0]['id']
                customer_result = await client.schema('basejump').from_('billing_customers').select('email').eq('account_id', account_id).execute()
                if customer_result.data and customer_result.data[0].get('email'):
                    return customer_result.data[0]['email']
        except Exception as e:
            logger.debug(f"Failed to get email via billing_customers for user {user_id}: {e}")
        
        return None
    
    async def _send_notification_email_with_retry(
        self,
        user_email: str,
        title: str,
        message: str,
        notification_type: str,
        notification_id: str,
        client
    ) -> tuple[bool, Optional[str]]:
        """Send email notification with retry logic using existing email service."""
        import asyncio
        
        async def attempt_send():
            # Get user name from email
            user_name = user_email.split('@')[0].title()
            
            # Build email content
            subject = f"🔔 {title}"
            
            # Create HTML email template
            html_content = self._get_notification_email_template(user_name, title, message, notification_type)
            text_content = self._get_notification_email_text(title, message)
            
            # Run synchronous email service in thread pool
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(
                None,
                lambda: email_service._send_email(
                    to_email=user_email,
                    to_name=user_name,
                    subject=subject,
                    html_content=html_content,
                    text_content=text_content
                )
            )
        
        try:
            success = await retry(attempt_send, max_attempts=3, delay_seconds=2)
            return success, None
        except Exception as e:
            error_msg = str(e)
            logger.error(f"Failed to send email after retries: {error_msg}")
            # Update retry count
            await client.table('notifications').update({
                'retry_count': 3,
                'last_retry_at': datetime.now(timezone.utc).isoformat()
            }).eq('id', notification_id).execute()
            return False, error_msg
    
    async def _send_push_notification_with_retry(
        self,
        push_token: str,
        title: str,
        message: str,
        notification_id: str,
        thread_id: Optional[str],
        agent_run_id: Optional[str],
        user_id: str,
        client
    ) -> tuple[bool, Optional[str]]:
        """Send push notification via Expo with retry logic and token validation."""
        
        async def attempt_send():
            # Basic token validation - Expo will validate the actual format
            if not push_token or len(push_token) < 10:
                raise ValueError(f"Invalid Expo push token: token too short")
            
            # Expo tokens are typically in format ExponentPushToken[UUID] but can vary
            # We'll let Expo's API validate the actual format
            
            # Prepare payload for Expo Push Notification API
            # Expo expects an array of notification objects
            payload = [{
                'to': push_token,
                'title': title,
                'body': message,
                'data': {
                    'notification_id': notification_id,
                    'thread_id': thread_id,
                    'agent_run_id': agent_run_id
                },
                'sound': 'default',
                'priority': 'default',
                'channelId': 'default',
                'badge': 1  # Show badge count
            }]
            
            # Expo Push Notification API requires specific headers
            headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip, deflate'
            }
            
            async with httpx.AsyncClient(timeout=10.0) as http_client:
                response = await http_client.post(self.expo_api_url, json=payload, headers=headers)
                
                if response.status_code == 200:
                    result = response.json()
                    # Expo returns array of results
                    if result.get('data') and len(result['data']) > 0:
                        receipt = result['data'][0]
                        status = receipt.get('status')
                        
                        if status == 'ok':
                            logger.debug(f"Push notification sent successfully to {push_token}")
                            # Check receipt for detailed status (Expo provides receipt API)
                            receipt_id = receipt.get('id')
                            if receipt_id:
                                # Validate receipt if needed
                                receipt_status = await self._check_expo_receipt(receipt_id)
                                if receipt_status and receipt_status.get('status') == 'error':
                                    error_code = receipt_status.get('details', {}).get('error')
                                    if error_code == 'DeviceNotRegistered':
                                        raise ValueError(f"DeviceNotRegistered: Token expired")
                                    elif error_code == 'InvalidCredentials':
                                        raise ValueError(f"InvalidCredentials: Token invalid")
                            return True
                        else:
                            error_msg = receipt.get('message', f"Expo push failed with status: {status}")
                            raise Exception(error_msg)
                    else:
                        raise Exception("No data in Expo response")
                else:
                    error_msg = f"HTTP {response.status_code}: {response.text[:200]}"
                    raise Exception(error_msg)
        
        try:
            success = await retry(attempt_send, max_attempts=3, delay_seconds=2)
            return success, None
        except ValueError as e:
            # Token validation errors - don't retry
            error_msg = str(e)
            logger.warning(f"Push token validation failed: {error_msg}")
            return False, error_msg
        except Exception as e:
            error_msg = str(e)
            logger.error(f"Failed to send push notification after retries: {error_msg}")
            # Update retry count
            await client.table('notifications').update({
                'retry_count': 3,
                'last_retry_at': datetime.now(timezone.utc).isoformat()
            }).eq('id', notification_id).execute()
            return False, error_msg
    
    async def _check_expo_receipt(self, receipt_id: str) -> Optional[Dict[str, Any]]:
        """Check Expo push notification receipt status."""
        try:
            # Expo receipt API: https://exp.host/--/api/v2/push/getReceipts
            receipt_url = self.expo_api_url.replace('/send', '/getReceipts')
            
            async with httpx.AsyncClient(timeout=5.0) as http_client:
                response = await http_client.post(receipt_url, json={'ids': [receipt_id]})
                
                if response.status_code == 200:
                    result = response.json()
                    if result.get('data') and receipt_id in result['data']:
                        return result['data'][receipt_id]
        except Exception as e:
            logger.warning(f"Error checking Expo receipt: {str(e)}")
        
        return None
    
    async def _mark_token_for_refresh(self, user_id: str, push_token: str, client):
        """Mark push token as invalid so it can be refreshed on next app open."""
        try:
            # Clear or mark token as needing refresh
            # We'll clear it so the app re-registers on next open
            await client.table('user_notification_preferences').update({
                'push_token': None,
                'push_token_updated_at': None
            }).eq('user_id', user_id).eq('push_token', push_token).execute()
            
            logger.info(f"Marked push token for refresh for user {user_id}")
        except Exception as e:
            logger.error(f"Error marking token for refresh: {str(e)}")
    
    def _get_notification_email_template(
        self,
        user_name: str,
        title: str,
        message: str,
        notification_type: str = "info"
    ) -> str:
        """Generate HTML email template for notifications."""
        # Color scheme based on notification type
        color_map = {
            'info': '#3B82F6',
            'success': '#10B981',
            'warning': '#F59E0B',
            'error': '#EF4444',
            'agent_complete': '#8B5CF6'
        }
        accent_color = color_map.get(notification_type, color_map['info'])
        
        return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <style>
    body {{
      font-family: Arial, sans-serif;
      background-color: #f5f5f5;
      color: #000000;
      margin: 0;
      padding: 0;
      line-height: 1.6;
    }}
    .container {{
      max-width: 600px;
      margin: 40px auto;
      padding: 30px;
      background-color: #ffffff;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }}
    .logo-container {{
      text-align: center;
      margin-bottom: 30px;
      padding: 10px 0;
    }}
    .logo {{
      max-width: 100%;
      height: auto;
      max-height: 60px;
      display: inline-block;
    }}
    .header {{
      border-left: 4px solid {accent_color};
      padding-left: 20px;
      margin-bottom: 20px;
    }}
    h1 {{
      font-size: 24px;
      color: #000000;
      margin: 0 0 10px 0;
    }}
    .message {{
      background-color: #f9fafb;
      padding: 20px;
      border-radius: 6px;
      margin: 20px 0;
      white-space: pre-wrap;
    }}
    p {{
      margin-bottom: 16px;
    }}
    .button {{
      display: inline-block;
      margin-top: 30px;
      background-color: {accent_color};
      color: white !important;
      padding: 14px 24px;
      text-align: center;
      text-decoration: none;
      font-weight: bold;
      border-radius: 6px;
      border: none;
    }}
    .button:hover {{
      opacity: 0.9;
      text-decoration: none;
    }}
    .footer {{
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #e5e7eb;
      font-size: 12px;
      color: #6b7280;
      text-align: center;
    }}
  </style>
</head>
<body>
  <div class="container">
    <div class="logo-container">
      <img src="https://i.postimg.cc/WdNtRx5Z/kortix-suna-logo.png" alt="Kortix Suna Logo" class="logo">
    </div>
    <div class="header">
      <h1>{title}</h1>
    </div>
    <p>Hi {user_name},</p>
    <div class="message">
      {message}
    </div>
    <a href="https://www.suna.so/" class="button">View in App</a>
    <div class="footer">
      <p>You received this notification from Suna.</p>
      <p>© 2025 Suna. All rights reserved.</p>
    </div>
  </div>
</body>
</html>"""
    
    def _get_notification_email_text(self, title: str, message: str) -> str:
        """Generate plain text email for notifications."""
        return f"""{title}

{message}

View in App: https://www.suna.so/

---
© 2025 Suna. All rights reserved.
You received this notification from Suna."""


# Global instance
notification_service = NotificationService()
