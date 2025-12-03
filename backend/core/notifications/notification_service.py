from typing import Dict, Optional, Any
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.config import config
from .novu_service import novu_service
from .presence_service import presence_service
from .models import UserNotificationSettings
from core.services.email import email_service

KORTIX_HELLO_EMAIL = 'hello@kortix.com'

class NotificationService:
    def __init__(self):
        self.db = DBConnection()
        self.novu = novu_service
        self._device_tokens: Dict[str, Dict[str, Any]] = {}
        self._notification_settings: Dict[str, UserNotificationSettings] = {}

    async def send_referral_code_notification(
        self,
        recipient_email: str,
        referral_url: str,
        inviter_id: str,
    ) -> Dict[str, Any]:
        try:
            inviter_info = await self._get_account_info(inviter_id)
            
            if not inviter_info or not inviter_info.get("email"):
                logger.error(f"No account found for inviter id: {inviter_id}")
                return {"success": False, "error": "Inviter not found"}

            inviter_name = inviter_info.get("name", "A friend")
            
            recipient_email_clean = recipient_email.strip().lower()
            recipient_name = self._extract_name_from_email(recipient_email_clean)
            
            success = email_service.send_referral_email(
                recipient_email=recipient_email_clean,
                recipient_name=recipient_name,
                sender_name=inviter_name,
                referral_url=referral_url
            )

            if success:
                logger.info(f"Referral code email sent to {recipient_email_clean} from {inviter_name}")
                return {"success": True}
            else:
                logger.error(f"Failed to send referral email to {recipient_email_clean}")
                return {"success": False, "error": "Failed to send email"}
        
        except Exception as e:
            logger.error(f"Error sending referral code notification: {str(e)}")
            return {"success": False, "error": str(e)}

    async def send_task_completion_notification(
        self,
        account_id: str,
        task_name: str,
        thread_id: str,
        agent_name: Optional[str] = None,
        result_summary: Optional[str] = None
    ) -> Dict[str, Any]:
        try:
            from core.notifications.presence_service import presence_service
            
            should_send = await presence_service.should_send_notification(
                account_id=account_id,
                thread_id=thread_id,
                channel="email"
            )
            
            if not should_send:
                logger.info(f"Suppressing task completion notification for account {account_id} (actively viewing thread {thread_id})")
                return {"success": False, "reason": "Account is actively viewing thread"}
            
            account_info = await self._get_account_info(account_id)
            
            client = await self.db.client
            thread_result = await client.table('threads').select('project_id').eq('thread_id', thread_id).maybe_single().execute()
            project_id = thread_result.data.get('project_id') if thread_result and thread_result.data else None
            
            task_url = f"https://www.kortix.com/projects/{project_id}/thread/{thread_id}" if project_id else f"https://www.kortix.com/thread/{thread_id}"
            
            payload = {
                "first_name": account_info.get("first_name"),
                "task_name": task_name,
                "task_url": task_url
            }
            
            result = await self.novu.trigger_workflow(
                workflow_id="task-completed",
                subscriber_id=account_id,
                payload=payload,
                subscriber_email=account_info.get("email"),
                subscriber_name=account_info.get("name")
            )
            
            logger.info(f"Task completion workflow triggered for account {account_id}: {result}")
            return {"success": True, "result": result}
            
        except Exception as e:
            logger.error(f"Error triggering task completion notification: {str(e)}")
            return {"success": False, "error": str(e)}
    
    async def send_task_failed_notification(
        self,
        account_id: str,
        task_name: str,
        task_url: str,
        failure_reason: str,
        first_name: Optional[str] = None,
        thread_id: Optional[str] = None
    ) -> Dict[str, Any]:
        try:
            from core.notifications.presence_service import presence_service
            
            if thread_id:
                should_send = await presence_service.should_send_notification(
                    account_id=account_id,
                    thread_id=thread_id,
                    channel="email"
                )
                
                if not should_send:
                    logger.info(f"Suppressing task failed notification for account {account_id} (actively viewing thread {thread_id})")
                    return {"success": False, "reason": "Account is actively viewing thread"}
            
            account_info = await self._get_account_info(account_id)
            
            payload = {
                "first_name": first_name or account_info.get("first_name"),
                "task_name": task_name,
                "task_url": task_url,
                "failure_reason": failure_reason
            }
            
            result = await self.novu.trigger_workflow(
                workflow_id="task-failed",
                subscriber_id=account_id,
                payload=payload,
                subscriber_email=account_info.get("email"),
                subscriber_name=account_info.get("name")
            )
            
            logger.info(f"Task failed workflow triggered for account {account_id}: {result}")
            return {"success": True, "result": result}
            
        except Exception as e:
            logger.error(f"Error triggering task failed notification: {str(e)}")
            return {"success": False, "error": str(e)}
    
    async def send_payment_succeeded_notification(
        self,
        account_id: str,
        amount: float,
        currency: str = "USD",
        plan_name: Optional[str] = None
    ) -> Dict[str, Any]:
        try:
            account_info = await self._get_account_info(account_id)
            
            payload = {
                "amount": amount,
                "currency": currency,
                "plan_name": plan_name,
                "formatted_amount": f"${amount:.2f}"
            }
            
            result = await self.novu.trigger_workflow(
                workflow_id="payment-succeeded",
                subscriber_id=account_id,
                payload=payload,
                subscriber_email=account_info.get("email"),
                subscriber_name=account_info.get("name")
            )
            
            return {"success": True, "result": result}
        except Exception as e:
            logger.error(f"Error triggering payment succeeded notification: {str(e)}")
            return {"success": False, "error": str(e)}
    
    async def send_payment_failed_notification(
        self,
        account_id: str,
        amount: float,
        currency: str = "USD",
        reason: Optional[str] = None
    ) -> Dict[str, Any]:
        try:
            account_info = await self._get_account_info(account_id)
            
            payload = {
                "amount": amount,
                "currency": currency,
                "reason": reason or "Payment processing failed",
                "formatted_amount": f"${amount:.2f}",
                "action_url": "/subscription"
            }
            
            result = await self.novu.trigger_workflow(
                workflow_id="payment-failed",
                subscriber_id=account_id,
                payload=payload,
                subscriber_email=account_info.get("email"),
                subscriber_name=account_info.get("name")
            )
            
            return {"success": True, "result": result}
        except Exception as e:
            logger.error(f"Error triggering payment failed notification: {str(e)}")
            return {"success": False, "error": str(e)}
    
    async def send_credits_low_notification(
        self,
        account_id: str,
        remaining_credits: float,
        threshold_percentage: int = 20
    ) -> Dict[str, Any]:
        try:
            account_info = await self._get_account_info(account_id)
            
            payload = {
                "remaining_credits": remaining_credits,
                "threshold_percentage": threshold_percentage,
                "action_url": "/subscription"
            }
            
            result = await self.novu.trigger_workflow(
                workflow_id="credits-low",
                subscriber_id=account_id,
                payload=payload,
                subscriber_email=account_info.get("email"),
                subscriber_name=account_info.get("name")
            )
            
            return {"success": True, "result": result}
        except Exception as e:
            logger.error(f"Error triggering credits low notification: {str(e)}")
            return {"success": False, "error": str(e)}
    
    async def send_promotional_notification(
        self,
        account_id: str,
        title: str,
        message: str,
        action_url: Optional[str] = None,
        image_url: Optional[str] = None
    ) -> Dict[str, Any]:
        try:
            account_info = await self._get_account_info(account_id)
            
            payload = {
                "title": title,
                "message": message,
                "action_url": action_url,
                "image_url": image_url
            }
            
            result = await self.novu.trigger_workflow(
                workflow_id="promotional",
                subscriber_id=account_id,
                payload=payload,
                subscriber_email=account_info.get("email"),
                subscriber_name=account_info.get("name")
            )
            
            return {"success": True, "result": result}
        except Exception as e:
            logger.error(f"Error triggering promotional notification: {str(e)}")
            return {"success": False, "error": str(e)}
    
    async def trigger_workflow_admin(
        self,
        workflow_id: str,
        payload_template: Dict[str, Any],
        subscriber_id: Optional[str] = None,
        subscriber_email: Optional[str] = None,
        broadcast: bool = False
    ) -> Dict[str, Any]:
        try:
            if broadcast:
                return await self._broadcast_workflow(workflow_id, payload_template)
            elif subscriber_email:
                return await self._trigger_workflow_by_email(workflow_id, payload_template, subscriber_email)
            elif subscriber_id:
                return await self._trigger_workflow_for_user(workflow_id, payload_template, subscriber_id)
            else:
                raise ValueError("Either subscriber_id, subscriber_email, or broadcast=True must be provided")
        except Exception as e:
            logger.error(f"Error triggering admin workflow: {str(e)}")
            return {"success": False, "error": str(e)}
    
    async def _trigger_workflow_for_user(
        self,
        workflow_id: str,
        payload_template: Dict[str, Any],
        subscriber_id: str
    ) -> Dict[str, Any]:
        account_info = await self._get_account_info(subscriber_id)
        
        if not account_info or not account_info.get("email"):
            return {"success": False, "error": f"No email found for subscriber {subscriber_id}"}
        
        await self.novu.upsert_subscriber(
            user_id=subscriber_id,
            email=account_info.get("email"),
            name=account_info.get("name"),
            phone=account_info.get("phone"),
            avatar=account_info.get("avatar")
        )
        
        payload = self._replace_template_variables(payload_template, account_info)
        
        result = await self.novu.trigger_workflow(
            workflow_id=workflow_id,
            subscriber_id=subscriber_id,
            payload=payload,
            subscriber_email=account_info.get("email"),
            subscriber_name=account_info.get("name"),
            avatar=account_info.get("avatar")
        )
        
        return {"success": True, "result": result, "subscriber_id": subscriber_id}
    
    async def _trigger_workflow_by_email(
        self,
        workflow_id: str,
        payload_template: Dict[str, Any],
        email: str
    ) -> Dict[str, Any]:
        email = email.strip().lower()
        
        client = await self.db.client
        
        try:
            user_response = await client.rpc('get_user_account_by_email', {'email_input': email}).execute()
            
            if user_response and user_response.data:
                subscriber_id = user_response.data.get('primary_owner_user_id')
                if subscriber_id:
                    return await self._trigger_workflow_for_user(workflow_id, payload_template, subscriber_id)
        except Exception as e:
            logger.warning(f"Could not find existing user for email {email}: {str(e)}")
        
        subscriber_id = f"email_{email.replace('@', '_at_').replace('.', '_')}"
        
        name = self._extract_name_from_email(email)
        
        await self.novu.upsert_subscriber(
            user_id=subscriber_id,
            email=email,
            name=name
        )
        
        account_info = {
            "email": email,
            "name": name,
            "first_name": name.split()[0] if name else "User",
            "phone": None,
            "avatar": None
        }
        
        payload = self._replace_template_variables(payload_template, account_info)
        
        result = await self.novu.trigger_workflow(
            workflow_id=workflow_id,
            subscriber_id=subscriber_id,
            payload=payload,
            subscriber_email=email,
            subscriber_name=name
        )
        
        return {"success": True, "result": result, "subscriber_id": subscriber_id, "email": email}
    
    def _extract_name_from_email(self, email: str) -> str:
        username = email.split('@')[0]
        
        username = username.replace('.', ' ').replace('_', ' ').replace('-', ' ')
        
        parts = username.split()
        
        formatted_name = ' '.join(word.capitalize() for word in parts if word)
        
        return formatted_name if formatted_name else "User"
    
    async def _broadcast_workflow(
        self,
        workflow_id: str,
        payload_template: Dict[str, Any]
    ) -> Dict[str, Any]:
        try:
            result = await self.novu.trigger_broadcast(
                workflow_id=workflow_id,
                payload=payload_template
            )
            
            if not result.get("success"):
                return result
            
            response_data = result.get("data", {})
            
            return {
                "success": True,
                "message": "Broadcast triggered successfully",
                "broadcast": True,
                "response": response_data
            }
            
        except Exception as e:
            logger.error(f"Error broadcasting workflow: {str(e)}")
            return {"success": False, "error": str(e)}
    
    def _replace_template_variables(
        self,
        payload_template: Dict[str, Any],
        account_info: Dict[str, Any]
    ) -> Dict[str, Any]:
        import re
        import json
        
        template_str = json.dumps(payload_template)
        
        replacements = {
            "{{email}}": account_info.get("email", ""),
            "{{name}}": account_info.get("name", ""),
            "{{first_name}}": account_info.get("first_name", ""),
            "{{phone}}": account_info.get("phone", ""),
            "{{avatar}}": account_info.get("avatar", ""),
        }
        
        for variable, value in replacements.items():
            template_str = template_str.replace(variable, str(value) if value else "")
        
        return json.loads(template_str)
    
    async def send_welcome_email(self, account_id: str) -> Dict[str, Any]:
        try:
            logger.info(f"[WELCOME_EMAIL] ENV_MODE={config.ENV_MODE.value if config.ENV_MODE else 'None'}, Novu enabled={self.novu.enabled}, API key configured={bool(self.novu.api_key)}")
            
            account_info = await self._get_account_info(account_id)
            
            if not account_info or not account_info.get("email"):
                logger.warning(f"[WELCOME_EMAIL] No email found for user {account_id}")
                return {"success": False, "error": "No email found for user"}
            
            email = account_info.get("email")
            name = account_info.get("name")
            phone = account_info.get("phone")
            avatar = account_info.get("avatar")
            
            logger.info(f"[WELCOME_EMAIL] Triggering for {account_id}: email={email}, name={name}, phone={phone}, avatar={avatar}")

            result = await self.novu.trigger_workflow(
                workflow_id="welcome-email",
                subscriber_id=account_id,
                subscriber_email=email,
                subscriber_name=name,
                avatar=avatar
            )
            
            if not result:
                logger.error(f"Failed to trigger welcome email workflow for account {account_id} - Novu returned False (ENV_MODE={config.ENV_MODE.value if config.ENV_MODE else 'None'})")
                return {"success": False, "error": "Failed to trigger workflow"}
            
            logger.info(f"Welcome email workflow triggered for account {account_id} (ENV_MODE: {config.ENV_MODE.value if config.ENV_MODE else 'None'})")
            return {"success": True, "result": result}
            
        except Exception as e:
            logger.error(f"Error triggering welcome email workflow: {str(e)}")
            return {"success": False, "error": str(e)}
    

    async def _get_account_info(self, account_id: str) -> Dict[str, Any]:
        try:
            client = await self.db.client
            
            email = None
            name = None
            phone = None
            avatar = None
            user_metadata = {}
            
            try:
                user = await client.auth.admin.get_user_by_id(account_id)
                if user and user.user:
                    email = user.user.email
                    user_metadata = user.user.user_metadata or {}
                    
                    name = (
                        user_metadata.get('full_name') or
                        user_metadata.get('name') or
                        user_metadata.get('display_name') or
                        (email.split('@')[0] if email else None)
                    )
                    
                    phone = user_metadata.get('phone') or user_metadata.get('phone_number')
                    avatar = user_metadata.get('avatar_url') or user_metadata.get('picture')
                    
            except Exception as e:
                logger.error(f"Error getting user details for account_id {account_id}: {str(e)}")
            
            if not email:
                logger.warning(f"No email found for account_id: {account_id}")
                return {}
            
            return {
                "email": email,
                "name": name,
                "phone": phone,
                "avatar": avatar,
                "first_name": name.split()[0] if name else "User"
            }
            
        except Exception as e:
            logger.error(f"Error getting account info for account_id: {account_id}: {str(e)}")
            return {}
    
    async def register_device_token(
        self,
        account_id: str,
        device_token: str,
        device_type: str = "mobile",
        provider: str = "expo"
    ) -> bool:
        try:
            result = await self.novu.register_push_token(
                user_id=account_id,
                provider_id=provider,
                device_token=device_token,
                device_type=device_type
            )
            
            if result:
                if account_id not in self._device_tokens:
                    self._device_tokens[account_id] = {}
                
                self._device_tokens[account_id][device_token] = {
                    "device_type": device_type,
                    "provider": provider,
                    "registered_at": None
                }
                
                logger.info(f"✅ Device token registered with Novu for account {account_id}: {device_token[:20]}...")
                return True
            else:
                logger.error(f"❌ Failed to register device token with Novu for account {account_id}")
                return False
            
        except Exception as e:
            logger.error(f"Error registering device token: {str(e)}")
            return False
    
    async def unregister_device_token(
        self,
        account_id: str,
        device_token: str,
        provider: str = "expo"
    ) -> bool:
        """Unregister a device token for push notifications."""
        try:
            result = await self.novu.unregister_push_token(
                user_id=account_id,
                provider_id=provider
            )
            
            if result:
                if account_id in self._device_tokens:
                    if device_token in self._device_tokens[account_id]:
                        del self._device_tokens[account_id][device_token]
                        logger.info(f"✅ Device token unregistered from Novu for account {account_id}")
                        return True
                
                logger.info(f"Device token already removed for account {account_id}")
                return True
            else:
                logger.error(f"❌ Failed to unregister device token from Novu for account {account_id}")
                return False
            
        except Exception as e:
            logger.error(f"Error unregistering device token: {str(e)}")
            return False
    
    async def get_account_notification_settings(
        self,
        account_id: str
    ) -> Optional[UserNotificationSettings]:
        """Get notification settings for an account."""
        try:
            return self._notification_settings.get(account_id)
        except Exception as e:
            logger.error(f"Error getting notification settings: {str(e)}")
            return None
    
    async def create_default_settings(
        self,
        account_id: str
    ) -> UserNotificationSettings:
        """Create default notification settings for an account."""
        try:
            settings = UserNotificationSettings(
                account_id=account_id,
                email_enabled=True,
                push_enabled=False,
                in_app_enabled=True
            )
            self._notification_settings[account_id] = settings
            logger.info(f"Created default notification settings for account {account_id}")
            return settings
        except Exception as e:
            logger.error(f"Error creating default settings: {str(e)}")
            # Return a default settings object even on error
            return UserNotificationSettings(
                account_id=account_id,
                email_enabled=True,
                push_enabled=False,
                in_app_enabled=True
            )
    
    async def update_account_notification_settings(
        self,
        account_id: str,
        settings: Dict[str, Any]
    ) -> bool:
        """Update notification settings for an account."""
        try:
            current_settings = self._notification_settings.get(account_id)
            
            if not current_settings:
                current_settings = await self.create_default_settings(account_id)
            
            # Update only the provided fields
            if "email_enabled" in settings:
                current_settings.email_enabled = settings["email_enabled"]
            if "push_enabled" in settings:
                current_settings.push_enabled = settings["push_enabled"]
            if "in_app_enabled" in settings:
                current_settings.in_app_enabled = settings["in_app_enabled"]
            
            self._notification_settings[account_id] = current_settings
            logger.info(f"Updated notification settings for account {account_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error updating notification settings: {str(e)}")
            return False
    
notification_service = NotificationService()
