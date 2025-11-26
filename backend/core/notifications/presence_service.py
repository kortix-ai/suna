from datetime import datetime, timezone, timedelta
from typing import Optional
from core.utils.logger import logger
from core.services.supabase import DBConnection

class PresenceService:
    def __init__(self):
        self.db = DBConnection()
        self.activity_threshold_minutes = 1
    
    async def update_presence(
        self,
        user_id: str,
        active_thread_id: Optional[str] = None,
        platform: str = "web",
        client_timestamp: Optional[str] = None
    ) -> bool:
        try:
            client = await self.db.client
            now = datetime.now(timezone.utc).isoformat()
            
            existing = await client.table('user_presence').select('*').eq(
                'user_id', user_id
            ).maybe_single().execute()
            
            should_update = True
            if existing and existing.data and client_timestamp:
                try:
                    existing_timestamp = existing.data.get('client_timestamp')
                    if existing_timestamp:
                        existing_dt = datetime.fromisoformat(existing_timestamp.replace('Z', '+00:00'))
                        client_dt = datetime.fromisoformat(client_timestamp.replace('Z', '+00:00'))
                        
                        if client_dt < existing_dt:
                            logger.warning(
                                f"Rejecting stale presence update for user {user_id}: "
                                f"client={client_dt}, existing={existing_dt}"
                            )
                            should_update = False
                except Exception as e:
                    logger.error(f"Error comparing timestamps: {str(e)}")
            
            if should_update:
                result = await client.table('user_presence').upsert({
                    'user_id': user_id,
                    'active_thread_id': active_thread_id,
                    'last_seen': now,
                    'platform': platform,
                    'updated_at': now,
                    'client_timestamp': client_timestamp or now
                }).execute()
                
                logger.debug(f"Presence upsert result for user {user_id}, thread {active_thread_id}: {result}")
            
            return True
            
        except Exception as e:
            logger.error(f"Error updating presence for user {user_id}: {str(e)}")
            return False
    
    async def clear_presence(self, user_id: str) -> bool:
        try:
            client = await self.db.client
            now = datetime.now(timezone.utc).isoformat()
            
            result = await client.table('user_presence').upsert({
                'user_id': user_id,
                'active_thread_id': None,
                'last_seen': now,
                'updated_at': now,
                'client_timestamp': now
            }).execute()
            
            logger.debug(f"Presence cleared for user {user_id}: {result}")
            
            return True
            
        except Exception as e:
            logger.error(f"Error clearing presence for user {user_id}: {str(e)}")
            return False
    
    async def is_user_viewing_thread(self, user_id: str, thread_id: str) -> bool:
        try:
            client = await self.db.client
            
            response = await client.table('user_presence').select('*').eq(
                'user_id', user_id
            ).maybe_single().execute()
            
            if not response or not response.data:
                return False
            
            presence = response.data
            
            if presence.get('active_thread_id') != thread_id:
                return False
            
            last_seen = datetime.fromisoformat(presence['last_seen'].replace('Z', '+00:00'))
            threshold = datetime.now(timezone.utc) - timedelta(minutes=self.activity_threshold_minutes)
            
            is_active = last_seen > threshold
            
            logger.debug(
                f"User {user_id} viewing thread {thread_id}: {is_active} "
                f"(last_seen: {last_seen}, threshold: {threshold})"
            )
            
            return is_active
            
        except Exception as e:
            logger.error(f"Error checking user presence: {str(e)}")
            return False
    
    async def should_send_notification(
        self,
        user_id: str,
        thread_id: Optional[str] = None,
        channel: str = "email"
    ) -> bool:
        if not thread_id:
            return True
        
        if channel == "in_app":
            return True
        
        is_viewing = await self.is_user_viewing_thread(user_id, thread_id)
        
        should_send = not is_viewing
        
        logger.info(
            f"Notification decision for user {user_id}, thread {thread_id}, "
            f"channel {channel}: {'SEND' if should_send else 'SUPPRESS'} "
            f"(user_viewing: {is_viewing})"
        )
        
        return should_send

presence_service = PresenceService()
