import os
from typing import Dict, List, Optional, Any
import novu_py
from novu_py import Novu
from core.utils.logger import logger
from core.utils.config import config, EnvMode
from .models import NotificationChannel, NotificationEvent, NotificationPayload


class NovuService:
    def __init__(self):
        self.enabled = True
        self.api_key = os.getenv('NOVU_SECRET_KEY')
        self.backend_url = os.getenv('NOVU_BACKEND_URL', 'https://api.novu.co')
        
        if not self.enabled:
            logger.info(f"Novu service disabled")
        elif not self.api_key:
            logger.warning("NOVU_SECRET_KEY not found in environment variables")
        else:
            logger.info(f"Novu service initialized with backend URL: {self.backend_url}")
    
    async def trigger_notification(
        self,
        event_name: str,
        user_id: str,
        payload: Dict[str, Any],
        subscriber_email: Optional[str] = None,
        subscriber_name: Optional[str] = None,
        override_email: Optional[str] = None,
        override_channels: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        if not self.enabled:
            logger.debug(f"Notification skipped (not in staging mode): {event_name}")
            return {"success": False, "error": "Notifications only enabled in staging mode"}
        
        if not self.api_key:
            logger.error("Cannot send notification: NOVU_SECRET_KEY not configured")
            return {"success": False, "error": "Novu not configured"}
        
        try:
            await self.upsert_subscriber(
                user_id=user_id,
                email=subscriber_email,
                name=subscriber_name
            )
            
            to_kwargs = {
                "subscriber_id": user_id,
            }
            
            if subscriber_email:
                to_kwargs["email"] = subscriber_email
            
            if subscriber_name:
                name_parts = subscriber_name.split()
                to_kwargs["first_name"] = name_parts[0] if name_parts else ""
                if len(name_parts) > 1:
                    to_kwargs["last_name"] = " ".join(name_parts[1:])
            
            trigger_request = novu_py.TriggerEventRequestDto(
                workflow_id=event_name,
                to=user_id,
                payload=payload,
            )
            
            if override_channels:
                trigger_request.overrides = override_channels
            
            with Novu(
                server_url=self.backend_url,
                secret_key=self.api_key,
            ) as novu:
                response = novu.trigger(trigger_event_request_dto=trigger_request)
            
            logger.info(f"Novu notification triggered: {event_name} for user {user_id}")
            
            transaction_id = None
            if hasattr(response, 'data') and response.data:
                transaction_id = getattr(response.data, 'transaction_id', None)
            
            return {
                "success": True,
                "transaction_id": transaction_id,
                "response": response
            }
            
        except Exception as e:
            logger.error(f"Error triggering Novu notification: {str(e)}")
            return {"success": False, "error": str(e)}
    
    async def upsert_subscriber(
        self,
        user_id: str,
        email: Optional[str] = None,
        name: Optional[str] = None,
        phone: Optional[str] = None,
        avatar: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None
    ) -> bool:
        if not self.enabled:
            return True
        
        if not self.api_key:
            logger.error("Cannot upsert subscriber: NOVU_SECRET_KEY not configured")
            return False
        
        try:
            with Novu(
                server_url=self.backend_url,
                secret_key=self.api_key,
            ) as novu:
                first_name = None
                last_name = None
                if name:
                    name_parts = name.split()
                    first_name = name_parts[0] if name_parts else None
                    if len(name_parts) > 1:
                        last_name = " ".join(name_parts[1:])
                
                try:
                    create_dto = novu_py.CreateSubscriberRequestDto(
                        subscriber_id=user_id,
                        email=email,
                        first_name=first_name,
                        last_name=last_name,
                        phone=phone,
                        avatar=avatar,
                        data=data,
                    )
                    novu.subscribers.create(create_subscriber_request_dto=create_dto)
                except Exception:
                    patch_dto = novu_py.PatchSubscriberRequestDto(
                        email=email,
                        first_name=first_name,
                        last_name=last_name,
                        phone=phone,
                        avatar=avatar,
                        data=data,
                    )
                    novu.subscribers.patch(subscriber_id=user_id, patch_subscriber_request_dto=patch_dto)
            
            logger.debug(f"Subscriber upserted: {user_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error upserting subscriber {user_id}: {str(e)}")
            return False
    
    async def update_subscriber_credentials(
        self,
        user_id: str,
        provider_id: str,
        credentials: Dict[str, Any],
        integration_identifier: Optional[str] = None
    ) -> bool:
        if not self.enabled:
            logger.debug(f"Skipping credential update (not in staging mode)")
            return True
        
        if not self.api_key:
            logger.error("Cannot update subscriber credentials: NOVU_SECRET_KEY not configured")
            return False
        
        try:
            import requests
            url = f"{self.backend_url}/v1/subscribers/{user_id}/credentials"
            headers = {
                "Authorization": f"ApiKey {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
            
            payload = {
                "providerId": provider_id,
                "credentials": credentials
            }
            
            if integration_identifier:
                payload["integrationIdentifier"] = integration_identifier
                
            response = requests.put(url, json=payload, headers=headers)
            response.raise_for_status()
            
            logger.info(f"✅ Set push credentials for subscriber {user_id} with provider {provider_id}")
            return True
            
        except Exception as e:
            logger.error(f"❌ Error updating subscriber credentials: {str(e)}")
            logger.error(f"   User ID: {user_id}, Provider: {provider_id}")
            return False
    
    async def set_subscriber_preference(
        self,
        user_id: str,
        template_id: str,
        channel: Optional[str] = None,
        enabled: bool = True
    ) -> bool:
        if not self.enabled:
            return True
        
        if not self.api_key:
            logger.error("Cannot set subscriber preference: NOVU_SECRET_KEY not configured")
            return False
        
        try:
            with Novu(
                server_url=self.backend_url,
                secret_key=self.api_key,
            ) as novu:
                update_data = {}
                if channel:
                     update_data = {"channel": {channel: enabled}}
                else:
                     update_data = {"enabled": enabled}

                novu.subscribers.preferences.update(
                    subscriber_id=user_id,
                    workflow_id=template_id,
                    update_subscriber_preference_request_dto=update_data
                )
            logger.info(f"Updated preference for subscriber {user_id}, template {template_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error updating subscriber preference: {str(e)}")
            return False
    
    async def delete_subscriber(self, user_id: str) -> bool:
        if not self.enabled:
            return True
        
        if not self.api_key:
            logger.error("Cannot delete subscriber: NOVU_SECRET_KEY not configured")
            return False
        
        try:
            with Novu(
                server_url=self.backend_url,
                secret_key=self.api_key,
            ) as novu:
                novu.subscribers.delete(subscriber_id=user_id)
            logger.info(f"Subscriber deleted: {user_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error deleting subscriber {user_id}: {str(e)}")
            return False
    
    async def get_subscriber(self, user_id: str) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            return None
        
        if not self.api_key:
            logger.error("Cannot get subscriber: NOVU_SECRET_KEY not configured")
            return None
        
        try:
            with Novu(
                server_url=self.backend_url,
                secret_key=self.api_key,
            ) as novu:
                # Using retrieve instead of get
                response = novu.subscribers.retrieve(subscriber_id=user_id)
            return response
            
        except Exception as e:
            logger.error(f"Error getting subscriber {user_id}: {str(e)}")
            return None
    
    async def trigger_workflow(
        self,
        workflow_id: str,
        subscriber_id: str,
        payload: Dict[str, Any],
        subscriber_email: Optional[str] = None,
        subscriber_name: Optional[str] = None
    ) -> bool:
        if not self.enabled:
            return False
        
        if not self.api_key:
            logger.error("Cannot trigger workflow: NOVU_SECRET_KEY not configured")
            return False
        
        try:
            if subscriber_email or subscriber_name:
                await self.upsert_subscriber(
                    user_id=subscriber_id,
                    email=subscriber_email,
                    name=subscriber_name
                )
            
            with Novu(
                server_url=self.backend_url,
                secret_key=self.api_key,
            ) as novu:
                response = novu.trigger(
                    trigger_event_request_dto=novu_py.TriggerEventRequestDto(
                        workflow_id=workflow_id,
                        to=subscriber_id,
                        payload=payload
                    )
                )

            return response
            
        except Exception as e:
            logger.error(f"Error triggering workflow {workflow_id}: {str(e)}")
            return False

    async def register_push_token(
        self,
        user_id: str,
        provider_id: str,
        device_token: str,
        device_type: str = "mobile",
        integration_identifier: Optional[str] = None
    ) -> bool:
        if not self.enabled:
            logger.debug(f"Skipping push token registration (not in staging mode)")
            return True
        
        if not self.api_key:
            logger.error("Cannot register push token: NOVU_SECRET_KEY not configured")
            return False
        
        try:
            credentials = {
                "deviceTokens": [device_token]
            }
            
            logger.info(f"📱 Registering push token for user {user_id[:8]}... with provider {provider_id}")
            
            return await self.update_subscriber_credentials(
                user_id=user_id,
                provider_id=provider_id,
                credentials=credentials,
                integration_identifier=integration_identifier
            )
            
        except Exception as e:
            logger.error(f"❌ Error registering push token: {str(e)}")
            return False


novu_service = NovuService()

