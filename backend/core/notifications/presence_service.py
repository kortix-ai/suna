from datetime import datetime, timezone, timedelta
from typing import Optional, Tuple, Any, Dict, List
from core.utils.logger import logger
from core.utils.config import config
from core.services.supabase import DBConnection
import uuid

class PresenceService:
    def __init__(self):
        self.db = DBConnection()
        self.activity_threshold_minutes = 2
        self.stale_session_threshold_minutes = 5
    
    async def _validate_account_id(self, account_id: str) -> bool:
        """Validate that account_id exists and is a valid UUID."""
        try:
            # Validate UUID format
            uuid.UUID(account_id)
            
            # Check if account exists in basejump.accounts
            client = await self.db.client
            result = await client.schema('basejump').from_('accounts').select('id').eq('id', account_id).limit(1).execute()
            
            if not result.data or len(result.data) == 0:
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
        """Fetch a presence session by session_id. Returns None if not found (handles 204 responses silently)."""
        try:
            client = await self.db.client
            return await client.table('user_presence_sessions').select('*').eq(
                'session_id', session_id
            ).maybe_single().execute()
        except Exception as e:
            # Handle PostgREST 204 "Missing response" - this is a valid "not found" case, not an error
            error_str = str(e).lower()
            if '204' in error_str and 'missing response' in error_str:
                # Session not found - return None silently (not an error)
                return None
            # Re-raise other exceptions
            raise

    async def _upsert_session(
        self,
        session_id: str,
        account_id: str,
        active_thread_id: Optional[str],
        platform: str,
        client_timestamp: Optional[str],
        device_info: Optional[Dict] = None
    ) -> Tuple[Any, str]:
        client = await self.db.client
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
        
        payload = {
            'session_id': session_id,
            'account_id': account_id,
            'active_thread_id': active_thread_id,
            'last_seen': now,
            'platform': platform,
            'device_info': device_info or {},
            'client_timestamp': client_timestamp or now,
            'updated_at': now
        }
        
        try:
            # Attempt upsert - service role client should bypass RLS, but handle errors gracefully
            result = await client.table('user_presence_sessions').upsert(payload).execute()
            return result, now
        except Exception as e:
            error_str = str(e).lower()
            # Check for RLS policy violations
            if 'row-level security' in error_str or 'policy' in error_str or 'permission denied' in error_str:
                logger.error(
                    f"RLS policy violation when upserting presence session {session_id} for account {account_id}: {str(e)}"
                )
                logger.error(f"Payload: {payload}")
                # Re-raise with clearer error message
                raise ValueError(f"Permission denied: Unable to update presence for account {account_id}. This may indicate an account membership issue.")
            else:
                # Log the full error for debugging
                logger.error(f"Error upserting presence session {session_id} for account {account_id}: {str(e)}")
                logger.error(f"Payload: {payload}")
                raise

    async def _delete_session(self, session_id: str):
        client = await self.db.client
        await client.table('user_presence_sessions').delete().eq(
            'session_id', session_id
        ).execute()

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
            client = await self.db.client
            threshold = datetime.now(timezone.utc) - timedelta(minutes=self.stale_session_threshold_minutes)
            
            query = client.table('user_presence_sessions').delete().lt('last_seen', threshold.isoformat())
            
            if account_id:
                query = query.eq('account_id', account_id)
                logger.debug(f"Cleaning up stale sessions for account {account_id}")
            else:
                logger.debug("Cleaning up all stale sessions")
            
            result = await query.execute()
            count = len(result.data) if result.data else 0
            
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
            client = await self.db.client
            result = await client.table('user_presence_sessions').select('*').eq(
                'account_id', account_id
            ).eq('active_thread_id', thread_id).execute()
            
            if not result.data:
                return False
            
            threshold = datetime.now(timezone.utc) - timedelta(minutes=self.activity_threshold_minutes)
            return any(
                datetime.fromisoformat(session['last_seen'].replace('Z', '+00:00')) > threshold
                for session in result.data
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
