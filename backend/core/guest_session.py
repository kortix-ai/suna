from typing import Optional, Dict, Any, Tuple
from datetime import datetime, timedelta
import hashlib
import uuid
import json
import asyncio
from fastapi import HTTPException, Request
from core.utils.logger import logger
from core.services import redis

SESSION_DURATION_HOURS = 24
GUEST_MESSAGE_LIMIT = 3
IP_HOURLY_LIMIT = 10
IP_DAILY_LIMIT = 30
CLEANUP_INTERVAL_HOURS = 1

REDIS_KEY_PREFIX_SESSION = "guest_session:"
REDIS_KEY_PREFIX_IP_HOURLY = "guest_ip_hourly:"
REDIS_KEY_PREFIX_IP_DAILY = "guest_ip_daily:"

class GuestSessionService:
    def __init__(self):
        self._cleanup_task: Optional[asyncio.Task] = None
        self._cleanup_running = False
    
    @staticmethod
    def is_guest_request(user_id: Optional[str]) -> bool:
        return user_id is None or user_id == ""
    
    async def is_guest_session(self, session_id: str) -> bool:
        if not session_id:
            return False
        session_key = f"{REDIS_KEY_PREFIX_SESSION}{session_id}"
        exists = await redis.get_client()
        result = await exists.exists(session_key)
        return result > 0
    
    def _get_ip_address(self, request: Request) -> str:
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"
    
    def _hash_ip(self, ip: str) -> str:
        return hashlib.sha256(ip.encode()).hexdigest()[:16]
    
    async def _check_ip_rate_limit(self, ip_hash: str) -> Tuple[bool, Optional[str]]:
        now = datetime.utcnow()
        client = await redis.get_client()
        
        hourly_key = f"{REDIS_KEY_PREFIX_IP_HOURLY}{ip_hash}"
        daily_key = f"{REDIS_KEY_PREFIX_IP_DAILY}{ip_hash}"
        
        hourly_count = await client.incr(hourly_key)
        if hourly_count == 1:
            await client.expire(hourly_key, 3600)
        
        daily_count = await client.incr(daily_key)
        if daily_count == 1:
            await client.expire(daily_key, 86400)
        
        if hourly_count > IP_HOURLY_LIMIT:
            return False, "Too many requests. Please try again in an hour or create an account."
        
        if daily_count > IP_DAILY_LIMIT:
            return False, "Daily limit reached. Please create an account to continue."
        
        return True, None
    
    async def get_or_create_session(
        self, 
        request: Request,
        session_id: Optional[str] = None
    ) -> Dict[str, Any]:
        if session_id and session_id.startswith('guest-'):
            session_id = session_id[6:]
            logger.debug(f"Stripped guest prefix, using session_id: {session_id[:8]}...")
        
        ip = self._get_ip_address(request)
        ip_hash = self._hash_ip(ip)
        
        allowed, error = await self._check_ip_rate_limit(ip_hash)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail={
                    'error': 'rate_limit_exceeded',
                    'message': error,
                    'action': 'signup_recommended'
                }
            )
        
        client = await redis.get_client()
        
        if session_id:
            session_key = f"{REDIS_KEY_PREFIX_SESSION}{session_id}"
            session_data = await client.get(session_key)
            
            if session_data:
                session = json.loads(session_data)
                
                if datetime.fromisoformat(session['expires_at']) < datetime.utcnow():
                    await client.delete(session_key)
                    raise HTTPException(
                        status_code=403,
                        detail={
                            'error': 'session_expired',
                            'message': 'Your trial session has expired. Create an account to continue.',
                            'action': 'signup_required'
                        }
                    )
                
                return session
        
        new_session_id = session_id if session_id else str(uuid.uuid4())
        now = datetime.utcnow()
        
        session = {
            'session_id': new_session_id,
            'messages_sent': 0,
            'messages_limit': GUEST_MESSAGE_LIMIT,
            'created_at': now.isoformat(),
            'expires_at': (now + timedelta(hours=SESSION_DURATION_HOURS)).isoformat(),
            'thread_ids': [],
            'is_guest': True
        }
        
        session_key = f"{REDIS_KEY_PREFIX_SESSION}{new_session_id}"
        ttl_seconds = SESSION_DURATION_HOURS * 3600
        await client.setex(session_key, ttl_seconds, json.dumps(session))
        
        logger.info(f"Created new guest session: {new_session_id}")
        
        return session
    
    async def check_message_limit(self, session_id: str) -> Tuple[bool, Optional[Dict]]:
        client = await redis.get_client()
        session_key = f"{REDIS_KEY_PREFIX_SESSION}{session_id}"
        session_data = await client.get(session_key)
        
        if not session_data:
            return False, {
                'error': 'session_not_found',
                'message': 'Session not found. Please refresh the app.',
                'action': 'refresh_required'
            }
        
        session = json.loads(session_data)
        
        if session['messages_sent'] >= session['messages_limit']:
            return False, {
                'error': 'message_limit_reached',
                'message': f"You've used all {session['messages_limit']} trial messages. Create a free account to continue!",
                'action': 'signup_required',
                'messages_sent': session['messages_sent'],
                'messages_limit': session['messages_limit']
            }
        
        return True, None
    
    async def increment_message_count(self, session_id: str) -> Dict[str, Any]:
        client = await redis.get_client()
        session_key = f"{REDIS_KEY_PREFIX_SESSION}{session_id}"
        session_data = await client.get(session_key)
        
        if not session_data:
            raise HTTPException(status_code=404, detail="Session not found")
        
        session = json.loads(session_data)
        session['messages_sent'] += 1
        session['last_message_at'] = datetime.utcnow().isoformat()
        
        ttl = await client.ttl(session_key)
        if ttl > 0:
            await client.setex(session_key, ttl, json.dumps(session))
        else:
            ttl_seconds = SESSION_DURATION_HOURS * 3600
            await client.setex(session_key, ttl_seconds, json.dumps(session))
        
        logger.info(f"Guest session {session_id}: {session['messages_sent']}/{session['messages_limit']} messages used")
        
        return session
    
    async def add_thread_to_session(self, session_id: str, thread_id: str):
        client = await redis.get_client()
        session_key = f"{REDIS_KEY_PREFIX_SESSION}{session_id}"
        session_data = await client.get(session_key)
        
        if session_data:
            session = json.loads(session_data)
            if thread_id not in session['thread_ids']:
                session['thread_ids'].append(thread_id)
                
                ttl = await client.ttl(session_key)
                if ttl > 0:
                    await client.setex(session_key, ttl, json.dumps(session))
                else:
                    ttl_seconds = SESSION_DURATION_HOURS * 3600
                    await client.setex(session_key, ttl_seconds, json.dumps(session))
    
    async def get_session_info(self, session_id: str) -> Optional[Dict[str, Any]]:
        client = await redis.get_client()
        session_key = f"{REDIS_KEY_PREFIX_SESSION}{session_id}"
        session_data = await client.get(session_key)
        
        if not session_data:
            return None
        
        session = json.loads(session_data)
        messages_remaining = session['messages_limit'] - session['messages_sent']
        
        return {
            'is_guest': True,
            'messages_sent': session['messages_sent'],
            'messages_limit': session['messages_limit'],
            'messages_remaining': messages_remaining,
            'expires_at': session['expires_at'],
            'show_signup_prompt': messages_remaining <= 2
        }
    
    async def cleanup_expired_sessions(self):
        client = await redis.get_client()
        pattern = f"{REDIS_KEY_PREFIX_SESSION}*"
        keys = await client.keys(pattern)
        
        now = datetime.utcnow()
        expired_count = 0
        
        for key in keys:
            session_data = await client.get(key)
            if session_data:
                try:
                    session = json.loads(session_data)
                    if datetime.fromisoformat(session['expires_at']) < now:
                        await client.delete(key)
                        session_id = key.replace(REDIS_KEY_PREFIX_SESSION, '')
                        logger.info(f"Cleaned up expired guest session: {session_id}")
                        expired_count += 1
                except (json.JSONDecodeError, KeyError) as e:
                    logger.warning(f"Error parsing session data for key {key}: {e}")
                    await client.delete(key)
                    expired_count += 1
        
        return expired_count
    
    async def _cleanup_loop(self):
        while self._cleanup_running:
            try:
                expired_count = await self.cleanup_expired_sessions()
                if expired_count > 0:
                    logger.info(f"Cleaned up {expired_count} expired guest sessions")
            except Exception as e:
                logger.error(f"Error in guest session cleanup loop: {e}")
            
            await asyncio.sleep(CLEANUP_INTERVAL_HOURS * 3600)
    
    def start_cleanup_task(self):
        if not self._cleanup_running:
            self._cleanup_running = True
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
            logger.info("Guest session cleanup task started")
    
    async def stop_cleanup_task(self):
        if self._cleanup_running:
            self._cleanup_running = False
            if self._cleanup_task:
                self._cleanup_task.cancel()
                try:
                    await self._cleanup_task
                except asyncio.CancelledError:
                    pass
            logger.info("Guest session cleanup task stopped")

guest_session_service = GuestSessionService()
