from datetime import datetime, timezone, timedelta
from typing import Optional, Tuple, Any, Dict, List
from core.utils.logger import logger
from core.utils.config import config
from core.services.supabase import DBConnection
import uuid

# Namespace UUID for generating deterministic UUIDs from non-UUID session IDs
PRESENCE_SESSION_NAMESPACE = uuid.UUID('a1b2c3d4-e5f6-7890-abcd-ef1234567890')


class PresenceService:
    def __init__(self):
        self.db = DBConnection()
        self.activity_threshold_minutes = 2
        self.stale_session_threshold_minutes = 5
    
    def _normalize_session_id(self, session_id: str) -> str:
        """
        Convert session_id to a valid UUID format.
        If session_id is already a valid UUID, return it as-is.
        Otherwise, generate a deterministic UUID5 from the session_id.
        """
        try:
            # Check if it's already a valid UUID
            uuid.UUID(session_id)
            return session_id
        except (ValueError, AttributeError):
            # Not a valid UUID - generate a deterministic UUID5 from the session_id
            deterministic_uuid = uuid.uuid5(PRESENCE_SESSION_NAMESPACE, session_id)
            logger.debug(f"Converted non-UUID session_id '{session_id}' to UUID '{deterministic_uuid}'")
            return str(deterministic_uuid)
    
    async def _validate_account_id(self, account_id: str) -> bool:
        try:
            # Validate UUID format
            uuid.UUID(account_id)
            from core.notifications import presence_repo
            exists = await presence_repo.validate_account_exists(account_id)
            
            if not exists:
                logger.warning(f"Account {account_id} does not exist in basejump.accounts")
                return False
            
            return True
        except ValueError:
            logger.error(f"Invalid UUID format for account_id: {account_id}")
            return False
        except Exception as e:
            logger.error(f"Error validating account_id {account_id}: {str(e)}")
            return False
    
    async def _fetch_session(self, session_id: str):
        """Fetch a presence session by session_id. Returns None if not found."""
        try:
            from core.notifications import presence_repo
            session = await presence_repo.get_presence_session(session_id)
            # Return in a format compatible with previous API
            if session:
                class Result:
                    data = session
                return Result()
            return None
        except Exception as e:
            logger.debug(f"Error fetching session {session_id}: {e}")
            return None

    async def _upsert_session(
        self,
        session_id: str,
        account_id: str,
        active_thread_id: Optional[str],
        platform: str,
        client_timestamp: Optional[str],
        device_info: Optional[Dict] = None
    ) -> Tuple[Any, str]:
        from core.notifications import presence_repo
        now = datetime.now(timezone.utc).isoformat()
        
        # Validate required fields
        if not session_id:
            raise ValueError("session_id is required")
        if not account_id:
            raise ValueError("account_id is required")
        
        # Validate account_id format and existence
        if not await self._validate_account_id(account_id):
            raise ValueError(f"Invalid or non-existent account_id: {account_id}")
        
        # Ensure platform has a default value
        if not platform:
            platform = "web"
        
        try:
            success = await presence_repo.upsert_presence_session(
                session_id=session_id,
                account_id=account_id,
                active_thread_id=active_thread_id,
                platform=platform,
                client_timestamp=client_timestamp,
                device_info=device_info
            )
            if not success:
                raise ValueError(f"Failed to upsert presence session {session_id}")
            return None, now
        except Exception as e:
            error_str = str(e).lower()
            if 'permission denied' in error_str or 'policy' in error_str:
                raise ValueError(f"Permission denied: Unable to update presence for account {account_id}. This may indicate an account membership issue.")
            raise

    async def _delete_session(self, session_id: str):
        from core.notifications import presence_repo
        await presence_repo.delete_presence_session(session_id)

    def _is_stale(self, client_timestamp: Optional[str], existing_timestamp: Optional[str]) -> bool:
        if not client_timestamp or not existing_timestamp:
            return False
        try:
            existing_dt = datetime.fromisoformat(existing_timestamp.replace('Z', '+00:00'))
            client_dt = datetime.fromisoformat(client_timestamp.replace('Z', '+00:00'))
            return client_dt < existing_dt
        except Exception as e:
            logger.error(f"Presence timestamp compare error: {str(e)}")
            return False

    async def update_presence(
        self,
        session_id: str,
        account_id: str,
        active_thread_id: Optional[str] = None,
        platform: str = "web",
        client_timestamp: Optional[str] = None,
        device_info: Optional[Dict] = None
    ) -> bool:
        if config.DISABLE_PRESENCE:
            return True
        
        # Normalize session_id to valid UUID format
        session_id = self._normalize_session_id(session_id)
        
        try:
            existing = await self._fetch_session(session_id)
            # Handle None result (session not found) gracefully - 204 responses return None
            existing_data = existing.data if existing and hasattr(existing, 'data') and existing.data else None
            
            is_new_session = not existing_data

            if existing_data and self._is_stale(client_timestamp, existing_data.get('client_timestamp')):
                logger.warning(
                    f"Rejecting stale presence update for session {session_id}: "
                    f"client={client_timestamp}, existing={existing_data.get('client_timestamp')}"
                )
                return True

            result, last_seen = await self._upsert_session(
                session_id=session_id,
                account_id=account_id,
                active_thread_id=active_thread_id,
                platform=platform,
                client_timestamp=client_timestamp,
                device_info=device_info
            )

            logger.debug(
                f"Presence upserted for session {session_id}, "
                f"account {account_id}, thread {active_thread_id}"
            )
            
            if is_new_session:
                await self.cleanup_stale_sessions(account_id)

            return True
            
        except ValueError as e:
            # Validation errors - log but don't fail silently
            logger.error(f"Validation error updating presence for session {session_id}: {str(e)}")
            return False
        except Exception as e:
            error_str = str(e).lower()
            # Check for RLS or permission errors
            if 'row-level security' in error_str or 'policy' in error_str or 'permission denied' in error_str or 'invalid or non-existent account_id' in error_str:
                logger.error(f"Permission/validation error updating presence for session {session_id}, account {account_id}: {str(e)}")
            else:
                logger.error(f"Error updating presence for session {session_id}: {str(e)}", exc_info=True)
            return False
    
    async def clear_presence(self, session_id: str, account_id: str) -> bool:
        if config.DISABLE_PRESENCE:
            return True
        
        # Normalize session_id to valid UUID format
        session_id = self._normalize_session_id(session_id)
        
        try:
            await self._delete_session(session_id)
            logger.debug(f"Presence cleared for session {session_id}, account {account_id}")
            return True
        except Exception as e:
            logger.error(f"Error clearing presence for session {session_id}: {str(e)}")
            return False
    
    async def cleanup_stale_sessions(self, account_id: Optional[str] = None) -> int:
        if config.DISABLE_PRESENCE:
            return 0
        
        try:
            from core.notifications import presence_repo
            
            if account_id:
                logger.debug(f"Cleaning up stale sessions for account {account_id}")
            else:
                logger.debug("Cleaning up all stale sessions")
            
            count = await presence_repo.delete_stale_sessions(
                self.stale_session_threshold_minutes,
                account_id
            )
            
            if count > 0:
                logger.info(f"Cleaned up {count} stale presence sessions")
            
            return count
            
        except Exception as e:
            logger.error(f"Error cleaning up stale sessions: {str(e)}")
            return 0
    
    async def is_account_viewing_thread(self, account_id: str, thread_id: str) -> bool:
        if config.DISABLE_PRESENCE:
            return False
        
        try:
            from core.notifications import presence_repo
            
            sessions = await presence_repo.get_sessions_by_account_and_thread(account_id, thread_id)
            
            if not sessions:
                return False
            
            threshold = datetime.now(timezone.utc) - timedelta(minutes=self.activity_threshold_minutes)
            return any(
                datetime.fromisoformat(str(session['last_seen']).replace('Z', '+00:00')) > threshold
                for session in sessions
            )
        except Exception as e:
            logger.error(f"Error checking account presence: {str(e)}")
            return False
    
    async def get_thread_viewers(self, thread_id: str) -> List[Dict[str, Any]]:
        if config.DISABLE_PRESENCE:
            return []
        
        try:
            client = await self.db.client
            result = await client.rpc('get_thread_viewers', {'thread_id_param': thread_id}).execute()
            return result.data if result.data else []
        except Exception as e:
            logger.error(f"Error getting thread viewers: {str(e)}")
            return []
    
    async def get_account_active_threads(self, account_id: str) -> List[Dict[str, Any]]:
        if config.DISABLE_PRESENCE:
            return []
        
        try:
            client = await self.db.client
            result = await client.rpc('get_account_active_threads', {'account_id_param': account_id}).execute()
            return result.data if result.data else []
        except Exception as e:
            logger.error(f"Error getting account active threads: {str(e)}")
            return []
    
    async def should_send_notification(
        self,
        account_id: str,
        thread_id: Optional[str] = None,
        channel: str = "email"
    ) -> bool:
        if config.DISABLE_PRESENCE:
            return True
        
        if not thread_id:
            return True
        
        if channel == "in_app":
            return True
        
        is_viewing = await self.is_account_viewing_thread(account_id, thread_id)
        
        should_send = not is_viewing
        
        logger.info(
            f"Notification decision for account {account_id}, thread {thread_id}, "
            f"channel {channel}: {'SEND' if should_send else 'SUPPRESS'} "
            f"(account_viewing: {is_viewing})"
        )
        
        return should_send


presence_service = PresenceService()
