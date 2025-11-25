from typing import Dict, List, Optional, Any
from datetime import datetime, timezone
from core.services.supabase import DBConnection
from core.utils.logger import logger
from .novu_service import novu_service
from .models import (
    NotificationChannel,
    NotificationEvent,
    NotificationPayload,
    NotificationPriority,
    NotificationPreference,
    UserNotificationSettings
)


class NotificationService:
    def __init__(self):
        self.db = DBConnection()
        self.novu = novu_service
    
    async def send_notification(
        self,
        event_type: NotificationEvent,
        user_id: str,
        data: Dict[str, Any],
        channels: Optional[List[NotificationChannel]] = None,
        priority: NotificationPriority = NotificationPriority.MEDIUM,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        try:
            user_prefs = await self.get_user_notification_settings(user_id)
            
            if not user_prefs:
                user_prefs = await self.create_default_settings(user_id)
            
            if not self._should_send_notification(event_type, user_prefs):
                logger.info(f"Notification {event_type} disabled for user {user_id}")
                return {"success": False, "reason": "Notification disabled by user preferences"}
            
            enabled_channels = await self.get_enabled_channels(user_id, event_type, channels)
            
            if not enabled_channels:
                logger.info(f"No enabled channels for {event_type} for user {user_id}")
                return {"success": False, "reason": "No enabled channels"}
            
            user_info = await self._get_user_info(user_id)
            
            event_name = self._map_event_to_workflow(event_type)
            
            payload = {
                **data,
                "user_id": user_id,
                "event_type": event_type.value,
                "priority": priority.value,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            
            if metadata:
                payload["metadata"] = metadata
            
            override_channels = self._build_channel_overrides(enabled_channels)
            
            result = await self.novu.trigger_notification(
                event_name=event_name,
                user_id=user_id,
                payload=payload,
                subscriber_email=user_info.get("email"),
                subscriber_name=user_info.get("name"),
                override_channels=override_channels
            )
            
            await self._log_notification(
                user_id=user_id,
                event_type=event_type,
                channels=enabled_channels,
                status="sent" if result.get("success") else "failed",
                transaction_id=result.get("transaction_id"),
                error=result.get("error"),
                payload=payload
            )
            
            return result
            
        except Exception as e:
            logger.error(f"Error sending notification: {str(e)}")
            return {"success": False, "error": str(e)}
    
    async def send_task_completion_notification(
        self,
        user_id: str,
        task_name: str,
        thread_id: str,
        agent_name: Optional[str] = None,
        result_summary: Optional[str] = None
    ) -> Dict[str, Any]:
        return await self.send_notification(
            event_type=NotificationEvent.TASK_COMPLETED,
            user_id=user_id,
            data={
                "task_name": task_name,
                "thread_id": thread_id,
                "agent_name": agent_name or "AI Agent",
                "result_summary": result_summary or "Task completed successfully",
                "view_url": f"/thread/{thread_id}"
            },
            priority=NotificationPriority.HIGH
        )
    
    async def send_task_failed_notification(
        self,
        user_id: str,
        task_name: str,
        task_url: str,
        failure_reason: str,
        first_name: Optional[str] = None
    ) -> Dict[str, Any]:
        payload = {
            "first_name": first_name,
            "task_name": task_name,
            "task_url": task_url,
            "failure_reason": failure_reason
        }
        return await self.novu.trigger_workflow(
            workflow_id='task-failed',
            subscriber_id=user_id,
            payload=payload
        )
    
    async def send_payment_succeeded_notification(
        self,
        user_id: str,
        amount: float,
        currency: str = "USD",
        plan_name: Optional[str] = None
    ) -> Dict[str, Any]:
        return await self.send_notification(
            event_type=NotificationEvent.PAYMENT_SUCCEEDED,
            user_id=user_id,
            data={
                "amount": amount,
                "currency": currency,
                "plan_name": plan_name,
                "formatted_amount": f"${amount:.2f}"
            },
            priority=NotificationPriority.MEDIUM
        )
    
    async def send_payment_failed_notification(
        self,
        user_id: str,
        amount: float,
        currency: str = "USD",
        reason: Optional[str] = None
    ) -> Dict[str, Any]:
        return await self.send_notification(
            event_type=NotificationEvent.PAYMENT_FAILED,
            user_id=user_id,
            data={
                "amount": amount,
                "currency": currency,
                "reason": reason or "Payment processing failed",
                "formatted_amount": f"${amount:.2f}",
                "action_url": "/subscription"
            },
            priority=NotificationPriority.URGENT
        )
    
    async def send_credits_low_notification(
        self,
        user_id: str,
        remaining_credits: float,
        threshold_percentage: int = 20
    ) -> Dict[str, Any]:
        return await self.send_notification(
            event_type=NotificationEvent.CREDITS_LOW,
            user_id=user_id,
            data={
                "remaining_credits": remaining_credits,
                "threshold_percentage": threshold_percentage,
                "action_url": "/subscription"
            },
            priority=NotificationPriority.HIGH
        )
    
    async def send_promotional_notification(
        self,
        user_id: str,
        title: str,
        message: str,
        action_url: Optional[str] = None,
        image_url: Optional[str] = None
    ) -> Dict[str, Any]:
        return await self.send_notification(
            event_type=NotificationEvent.PROMOTIONAL,
            user_id=user_id,
            data={
                "title": title,
                "message": message,
                "action_url": action_url,
                "image_url": image_url
            },
            priority=NotificationPriority.LOW
        )
    
    async def get_user_notification_settings(self, user_id: str) -> Optional[UserNotificationSettings]:
        try:
            client = await self.db.client
            response = await client.table('notification_settings').select('*').eq('user_id', user_id).maybe_single().execute()
            
            if response and response.data:
                return UserNotificationSettings(**response.data)
            return None
            
        except Exception as e:
            logger.error(f"Error getting notification settings for user {user_id}: {str(e)}")
            return None
    
    async def update_user_notification_settings(
        self,
        user_id: str,
        settings: Dict[str, Any]
    ) -> bool:
        try:
            client = await self.db.client
            
            settings['user_id'] = user_id
            settings['updated_at'] = datetime.now(timezone.utc).isoformat()
            
            await client.table('notification_settings').upsert(settings).execute()
            
            logger.info(f"Updated notification settings for user {user_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error updating notification settings: {str(e)}")
            return False
    
    async def create_default_settings(self, user_id: str) -> UserNotificationSettings:
        default_settings = UserNotificationSettings(user_id=user_id)
        
        await self.update_user_notification_settings(
            user_id=user_id,
            settings=default_settings.dict()
        )
        
        return default_settings
    
    async def get_enabled_channels(
        self,
        user_id: str,
        event_type: NotificationEvent,
        requested_channels: Optional[List[NotificationChannel]] = None
    ) -> List[NotificationChannel]:
        user_settings = await self.get_user_notification_settings(user_id)
        
        if not user_settings:
            return [NotificationChannel.EMAIL, NotificationChannel.IN_APP]
        
        enabled = []
        
        if user_settings.email_enabled and (not requested_channels or NotificationChannel.EMAIL in requested_channels):
            enabled.append(NotificationChannel.EMAIL)
        
        if user_settings.in_app_enabled and (not requested_channels or NotificationChannel.IN_APP in requested_channels):
            enabled.append(NotificationChannel.IN_APP)
        
        if user_settings.push_enabled and (not requested_channels or NotificationChannel.PUSH in requested_channels):
            enabled.append(NotificationChannel.PUSH)
        
        if user_settings.sms_enabled and (not requested_channels or NotificationChannel.SMS in requested_channels):
            enabled.append(NotificationChannel.SMS)
        
        return enabled
    
    async def register_device_token(
        self,
        user_id: str,
        device_token: str,
        device_type: str = "mobile",
        provider: str = "fcm"
    ) -> bool:
        try:
            client = await self.db.client
            
            await client.table('device_tokens').upsert({
                'user_id': user_id,
                'device_token': device_token,
                'device_type': device_type,
                'provider': provider,
                'is_active': True,
                'registered_at': datetime.now(timezone.utc).isoformat(),
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).execute()
            
            await self.novu.register_push_token(
                user_id=user_id,
                provider_id=provider,
                device_token=device_token,
                device_type=device_type
            )
            
            logger.info(f"Registered device token for user {user_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error registering device token: {str(e)}")
            return False
    
    async def unregister_device_token(self, user_id: str, device_token: str) -> bool:
        try:
            client = await self.db.client
            
            await client.table('device_tokens').update({
                'is_active': False,
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).eq('user_id', user_id).eq('device_token', device_token).execute()
            
            logger.info(f"Unregistered device token for user {user_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error unregistering device token: {str(e)}")
            return False
    
    def _should_send_notification(
        self,
        event_type: NotificationEvent,
        user_settings: UserNotificationSettings
    ) -> bool:
        if event_type in [NotificationEvent.TASK_COMPLETED, NotificationEvent.TASK_FAILED, NotificationEvent.AGENT_RUN_COMPLETED, NotificationEvent.AGENT_RUN_FAILED, NotificationEvent.TRIGGER_EXECUTED, NotificationEvent.TRIGGER_FAILED]:
            return user_settings.task_notifications
        
        if event_type in [NotificationEvent.SUBSCRIPTION_CREATED, NotificationEvent.SUBSCRIPTION_RENEWED, NotificationEvent.SUBSCRIPTION_CANCELLED, NotificationEvent.PAYMENT_SUCCEEDED, NotificationEvent.PAYMENT_FAILED, NotificationEvent.CREDITS_LOW, NotificationEvent.CREDITS_DEPLETED]:
            return user_settings.billing_notifications
        
        if event_type == NotificationEvent.PROMOTIONAL:
            return user_settings.promotional_notifications
        
        if event_type in [NotificationEvent.SYSTEM_ALERT, NotificationEvent.WELCOME]:
            return user_settings.system_notifications
        
        return True
    
    def _map_event_to_workflow(self, event_type: NotificationEvent) -> str:
        workflow_mapping = {
            NotificationEvent.TASK_COMPLETED: "task-completed",
            NotificationEvent.TASK_FAILED: "task-failed",
            NotificationEvent.AGENT_RUN_COMPLETED: "agent-run-completed",
            NotificationEvent.AGENT_RUN_FAILED: "agent-run-failed",
            NotificationEvent.PAYMENT_SUCCEEDED: "payment-succeeded",
            NotificationEvent.PAYMENT_FAILED: "payment-failed",
            NotificationEvent.SUBSCRIPTION_CREATED: "subscription-created",
            NotificationEvent.SUBSCRIPTION_RENEWED: "subscription-renewed",
            NotificationEvent.SUBSCRIPTION_CANCELLED: "subscription-cancelled",
            NotificationEvent.CREDITS_LOW: "credits-low",
            NotificationEvent.CREDITS_DEPLETED: "credits-depleted",
            NotificationEvent.WELCOME: "welcome",
            NotificationEvent.PROMOTIONAL: "promotional",
            NotificationEvent.SYSTEM_ALERT: "system-alert",
            NotificationEvent.TRIGGER_EXECUTED: "trigger-executed",
            NotificationEvent.TRIGGER_FAILED: "trigger-failed",
        }
        
        return workflow_mapping.get(event_type, event_type.value)
    
    def _build_channel_overrides(self, enabled_channels: List[NotificationChannel]) -> Dict[str, Any]:
        overrides = {}
        
        all_channels = [NotificationChannel.EMAIL, NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.SMS]
        
        for channel in all_channels:
            channel_key = channel.value
            overrides[channel_key] = {"active": channel in enabled_channels}
        
        return overrides
    
    async def _get_user_info(self, user_id: str) -> Dict[str, Any]:
        try:
            client = await self.db.client
            
            user_response = await client.auth.admin.get_user_by_id(user_id)
            
            if user_response and user_response.user:
                user = user_response.user
                email = user.email
                metadata = user.user_metadata or {}
                name = metadata.get('full_name') or metadata.get('name') or (email.split('@')[0] if email else None)
                
                return {
                    "email": email,
                    "name": name
                }
            
            return {}
            
        except Exception as e:
            logger.error(f"Error getting user info: {str(e)}")
            return {}
    
    async def _log_notification(
        self,
        user_id: str,
        event_type: NotificationEvent,
        channels: List[NotificationChannel],
        status: str,
        transaction_id: Optional[str] = None,
        error: Optional[str] = None,
        payload: Optional[Dict[str, Any]] = None
    ) -> None:
        try:
            client = await self.db.client
            
            for channel in channels:
                await client.table('notification_logs').insert({
                    'user_id': user_id,
                    'event_type': event_type.value,
                    'channel': channel.value,
                    'status': status,
                    'novu_transaction_id': transaction_id,
                    'error_message': error,
                    'payload': payload,
                    'created_at': datetime.now(timezone.utc).isoformat()
                }).execute()
            
        except Exception as e:
            logger.error(f"Error logging notification: {str(e)}")


notification_service = NotificationService()

