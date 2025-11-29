from typing import Dict, Optional, Any
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.config import config
from .novu_service import novu_service
from .presence_service import presence_service

class NotificationService:
    def __init__(self):
        self.db = DBConnection()
        self.novu = novu_service
    
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
    
notification_service = NotificationService()
