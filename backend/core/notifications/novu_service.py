import os
from typing import Dict, List, Optional, Any
from novu.api import EventApi
from novu.config import NovuConfig
from novu.dto.subscriber import SubscriberDto
from novu.api.subscriber import SubscriberApi
from core.utils.logger import logger
from .models import NotificationChannel, NotificationEvent, NotificationPayload


class NovuService:
    def __init__(self):
        self.api_key = os.getenv('NOVU_API_KEY')
        self.backend_url = os.getenv('NOVU_BACKEND_URL', 'https://api.novu.co')
        
        if not self.api_key:
            logger.warning("NOVU_API_KEY not found in environment variables")
            self.event_api = None
            self.subscriber_api = None
        else:
            config = NovuConfig()
            config.api_key = self.api_key
            config.backend_url = self.backend_url
            
            self.event_api = EventApi(config=config)
            self.subscriber_api = SubscriberApi(config=config)
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
        if not self.event_api:
            logger.error("Cannot send notification: NOVU_API_KEY not configured")
            return {"success": False, "error": "Novu not configured"}
        
        try:
            await self.upsert_subscriber(
                user_id=user_id,
                email=subscriber_email,
                name=subscriber_name
            )
            
            trigger_payload = {
                "name": event_name,
                "to": {
                    "subscriberId": user_id,
                },
                "payload": payload,
            }
            
            if override_email:
                trigger_payload["to"]["email"] = override_email
            
            if override_channels:
                trigger_payload["overrides"] = override_channels
            
            response = self.event_api.trigger(**trigger_payload)
            
            logger.info(f"Novu notification triggered: {event_name} for user {user_id}")
            return {
                "success": True,
                "transaction_id": response.get("data", {}).get("transactionId"),
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
        if not self.subscriber_api:
            logger.error("Cannot upsert subscriber: NOVU_API_KEY not configured")
            return False
        
        try:
            subscriber_data = {
                "subscriberId": user_id,
            }
            
            if email:
                subscriber_data["email"] = email
            if name:
                subscriber_data["firstName"] = name.split()[0] if name else ""
                subscriber_data["lastName"] = " ".join(name.split()[1:]) if len(name.split()) > 1 else ""
            if phone:
                subscriber_data["phone"] = phone
            if avatar:
                subscriber_data["avatar"] = avatar
            if data:
                subscriber_data["data"] = data
            
            self.subscriber_api.identify(**subscriber_data)
            logger.debug(f"Subscriber upserted: {user_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error upserting subscriber {user_id}: {str(e)}")
            return False
    
    async def update_subscriber_credentials(
        self,
        user_id: str,
        provider_id: str,
        credentials: Dict[str, Any]
    ) -> bool:
        if not self.subscriber_api:
            logger.error("Cannot update subscriber credentials: NOVU_API_KEY not configured")
            return False
        
        try:
            self.subscriber_api.update_subscriber_credentials(
                subscriber_id=user_id,
                provider_id=provider_id,
                credentials=credentials
            )
            logger.info(f"Updated credentials for subscriber {user_id}, provider {provider_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error updating subscriber credentials: {str(e)}")
            return False
    
    async def set_subscriber_preference(
        self,
        user_id: str,
        template_id: str,
        channel: Optional[str] = None,
        enabled: bool = True
    ) -> bool:
        if not self.subscriber_api:
            logger.error("Cannot set subscriber preference: NOVU_API_KEY not configured")
            return False
        
        try:
            preference_data = {
                "subscriberId": user_id,
                "templateId": template_id,
                "enabled": enabled
            }
            
            if channel:
                preference_data["channel"] = channel
            
            self.subscriber_api.update_subscriber_preference(**preference_data)
            logger.info(f"Updated preference for subscriber {user_id}, template {template_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error updating subscriber preference: {str(e)}")
            return False
    
    async def delete_subscriber(self, user_id: str) -> bool:
        if not self.subscriber_api:
            logger.error("Cannot delete subscriber: NOVU_API_KEY not configured")
            return False
        
        try:
            self.subscriber_api.delete(subscriber_id=user_id)
            logger.info(f"Subscriber deleted: {user_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error deleting subscriber {user_id}: {str(e)}")
            return False
    
    async def get_subscriber(self, user_id: str) -> Optional[Dict[str, Any]]:
        if not self.subscriber_api:
            logger.error("Cannot get subscriber: NOVU_API_KEY not configured")
            return None
        
        try:
            response = self.subscriber_api.get(subscriber_id=user_id)
            return response
            
        except Exception as e:
            logger.error(f"Error getting subscriber {user_id}: {str(e)}")
            return None
    
    async def register_push_token(
        self,
        user_id: str,
        provider_id: str,
        device_token: str,
        device_type: str = "mobile"
    ) -> bool:
        if not self.subscriber_api:
            logger.error("Cannot register push token: NOVU_API_KEY not configured")
            return False
        
        try:
            credentials = {
                "deviceTokens": [device_token],
                "deviceType": device_type
            }
            
            return await self.update_subscriber_credentials(
                user_id=user_id,
                provider_id=provider_id,
                credentials=credentials
            )
            
        except Exception as e:
            logger.error(f"Error registering push token: {str(e)}")
            return False


novu_service = NovuService()

