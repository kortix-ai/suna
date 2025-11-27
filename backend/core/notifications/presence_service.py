from datetime import datetime, timezone, timedelta
from typing import Optional, Tuple, Any, Dict, List
import json
from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.services import redis

REDIS_PRESENCE_SESSION_KEY_PREFIX = "presence:session"
REDIS_ACCOUNT_SESSIONS_KEY_PREFIX = "presence:account_sessions"
REDIS_THREAD_KEY_PREFIX = "presence:thread"
REDIS_EVENT_CHANNEL = "presence:events"
REDIS_TTL_SECONDS = 120


class PresenceService:
    def __init__(self):
        self.db = DBConnection()
        self.activity_threshold_minutes = 1
        self.stale_session_threshold_minutes = 5
    
    def _session_key(self, session_id: str) -> str:
        return f"{REDIS_PRESENCE_SESSION_KEY_PREFIX}:{session_id}"
    
    def _account_sessions_key(self, account_id: str) -> str:
        return f"{REDIS_ACCOUNT_SESSIONS_KEY_PREFIX}:{account_id}"
    
    def _thread_key(self, thread_id: str) -> str:
        return f"{REDIS_THREAD_KEY_PREFIX}:{thread_id}"
    
    async def _fetch_session(self, session_id: str):
        client = await self.db.client
        return await client.table('user_presence_sessions').select('*').eq(
            'session_id', session_id
        ).maybe_single().execute()

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
        result = await client.table('user_presence_sessions').upsert(payload).execute()
        return result, now

    async def _delete_session(self, session_id: str):
        client = await self.db.client
        await client.table('user_presence_sessions').delete().eq(
            'session_id', session_id
        ).execute()

    async def _write_cache(self, session_id: str, payload: dict):
        try:
            redis_client = await redis.get_client()
            await redis_client.setex(
                self._session_key(session_id),
                REDIS_TTL_SECONDS,
                json.dumps(payload)
            )
            await redis_client.sadd(self._account_sessions_key(payload['account_id']), session_id)
            await redis_client.expire(self._account_sessions_key(payload['account_id']), REDIS_TTL_SECONDS)
        except Exception as e:
            logger.warning(f"Presence session cache write error: {str(e)}")

    async def _remove_cache(self, session_id: str, account_id: str):
        try:
            redis_client = await redis.get_client()
            await redis_client.delete(self._session_key(session_id))
            await redis_client.srem(self._account_sessions_key(account_id), session_id)
        except Exception as e:
            logger.warning(f"Presence session cache delete error: {str(e)}")

    async def _read_cache(self, session_id: str) -> Optional[dict]:
        try:
            redis_client = await redis.get_client()
            cached = await redis_client.get(self._session_key(session_id))
            if cached:
                if isinstance(cached, bytes):
                    cached = cached.decode('utf-8')
                return json.loads(cached)
        except Exception as e:
            logger.warning(f"Presence session cache read error: {str(e)}")
        return None

    async def _sync_thread_membership(
        self,
        session_id: str,
        account_id: str,
        previous_thread: Optional[str],
        next_thread: Optional[str]
    ):
        try:
            redis_client = await redis.get_client()
            session_account_key = f"{session_id}:{account_id}"
            
            if previous_thread and previous_thread != next_thread:
                await redis_client.srem(self._thread_key(previous_thread), session_account_key)
            
            if next_thread:
                thread_key = self._thread_key(next_thread)
                await redis_client.sadd(thread_key, session_account_key)
                await redis_client.expire(thread_key, REDIS_TTL_SECONDS)
        except Exception as e:
            logger.warning(f"Presence thread sync error: {str(e)}")

    async def _publish_event(self, payload: dict):
        try:
            result = await redis.publish(REDIS_EVENT_CHANNEL, json.dumps(payload))
            logger.debug(
                f"Published presence event to {REDIS_EVENT_CHANNEL}: "
                f"{payload.get('type')} for account {payload.get('account_id')}, "
                f"session {payload.get('session_id')}, subscribers: {result}"
            )
        except Exception as e:
            logger.warning(f"Presence publish error: {str(e)}")

    def _build_payload(
        self,
        *,
        event_type: str,
        session_id: str,
        account_id: str,
        active_thread_id: Optional[str],
        platform: str,
        last_seen: str,
        client_timestamp: Optional[str]
    ) -> Dict[str, Any]:
        return {
            "type": event_type,
            "session_id": session_id,
            "account_id": account_id,
            "active_thread_id": active_thread_id,
            "platform": platform,
            "status": "online" if event_type == "presence_update" and active_thread_id else (
                "offline" if event_type == "presence_clear" else "idle"
            ),
            "last_seen": last_seen,
            "client_timestamp": client_timestamp or last_seen
        }

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
        try:
            existing = await self._fetch_session(session_id)
            existing_data = existing.data if existing and existing.data else None
            
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
                f"Presence upsert result for session {session_id}, "
                f"account {account_id}, thread {active_thread_id}: {result}"
            )

            previous_thread = existing_data.get('active_thread_id') if existing_data else None

            payload = self._build_payload(
                event_type="presence_update",
                session_id=session_id,
                account_id=account_id,
                active_thread_id=active_thread_id,
                platform=platform,
                last_seen=last_seen,
                client_timestamp=client_timestamp
            )

            await self._write_cache(session_id, payload)
            await self._sync_thread_membership(session_id, account_id, previous_thread, active_thread_id)
            await self._publish_event(payload)
            
            if is_new_session:
                await self.cleanup_stale_sessions(account_id)

            return True
            
        except Exception as e:
            logger.error(f"Error updating presence for session {session_id}: {str(e)}")
            return False
    
    async def clear_presence(self, session_id: str, account_id: str) -> bool:
        try:
            cached = await self._read_cache(session_id)
            previous_thread = cached.get('active_thread_id') if cached else None

            if previous_thread is None:
                existing = await self._fetch_session(session_id)
                if existing and existing.data:
                    previous_thread = existing.data.get('active_thread_id')
            
            await self._delete_session(session_id)
            
            logger.debug(f"Presence cleared for session {session_id}, account {account_id}")

            payload = self._build_payload(
                event_type="presence_clear",
                session_id=session_id,
                account_id=account_id,
                active_thread_id=None,
                platform=cached.get('platform') if cached else "web",
                last_seen=datetime.now(timezone.utc).isoformat(),
                client_timestamp=None
            )

            await self._remove_cache(session_id, account_id)
            await self._sync_thread_membership(session_id, account_id, previous_thread, None)
            await self._publish_event(payload)
            
            return True
            
        except Exception as e:
            logger.error(f"Error clearing presence for session {session_id}: {str(e)}")
            return False
    
    async def cleanup_stale_sessions(self, account_id: Optional[str] = None) -> int:
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
        try:
            redis_client = await redis.get_client()
            account_sessions = await redis_client.smembers(self._account_sessions_key(account_id))
            
            if not account_sessions:
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
            
            for session_id in account_sessions:
                if isinstance(session_id, bytes):
                    session_id = session_id.decode('utf-8')
                cached = await self._read_cache(session_id)
                if cached and cached.get('active_thread_id') == thread_id:
                    last_seen_str = cached.get('last_seen')
                    if last_seen_str:
                        last_seen = datetime.fromisoformat(last_seen_str.replace('Z', '+00:00'))
                        threshold = datetime.now(timezone.utc) - timedelta(minutes=self.activity_threshold_minutes)
                        if last_seen > threshold:
                            return True
            
            return False
            
        except Exception as e:
            logger.error(f"Error checking account presence: {str(e)}")
            return False
    
    async def get_thread_viewers(self, thread_id: str) -> List[Dict[str, Any]]:
        try:
            client = await self.db.client
            result = await client.rpc('get_thread_viewers', {'thread_id_param': thread_id}).execute()
            return result.data if result.data else []
        except Exception as e:
            logger.error(f"Error getting thread viewers: {str(e)}")
            return []
    
    async def get_account_active_threads(self, account_id: str) -> List[Dict[str, Any]]:
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
