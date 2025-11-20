from typing import Optional, Dict, Any, Tuple
from datetime import datetime, timedelta
import hashlib
import uuid
import json
from fastapi import HTTPException, Request
from core.utils.logger import logger

SESSION_DURATION_HOURS = 24
GUEST_MESSAGE_LIMIT = 5
IP_HOURLY_LIMIT = 99999999
IP_DAILY_LIMIT = 9999999000


class GuestSessionService:
    def __init__(self):
        self._sessions = {}
        self._ip_limits = {}
    
    @staticmethod
    def is_guest_request(user_id: Optional[str]) -> bool:
        return user_id is None or user_id == ""
    
    def is_guest_session(self, session_id: str) -> bool:
        if not session_id:
            return False
        return session_id in self._sessions
    
    def _get_ip_address(self, request: Request) -> str:
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"
    
    def _hash_ip(self, ip: str) -> str:
        return hashlib.sha256(ip.encode()).hexdigest()[:16]
    
    def _check_ip_rate_limit(self, ip_hash: str) -> Tuple[bool, Optional[str]]:
        now = datetime.utcnow()
        
        if ip_hash not in self._ip_limits:
            self._ip_limits[ip_hash] = {
                'hourly': [],
                'daily': [],
                'created_at': now
            }
        
        limits = self._ip_limits[ip_hash]
        
        one_hour_ago = now - timedelta(hours=1)
        one_day_ago = now - timedelta(days=1)
        
        limits['hourly'] = [t for t in limits['hourly'] if t > one_hour_ago]
        limits['daily'] = [t for t in limits['daily'] if t > one_day_ago]
        
        if len(limits['hourly']) >= IP_HOURLY_LIMIT:
            return False, "Too many requests. Please try again in an hour or create an account."
        
        if len(limits['daily']) >= IP_DAILY_LIMIT:
            return False, "Daily limit reached. Please create an account to continue."
        
        limits['hourly'].append(now)
        limits['daily'].append(now)
        
        return True, None
    
    def get_or_create_session(
        self, 
        request: Request,
        session_id: Optional[str] = None
    ) -> Dict[str, Any]:
        if session_id and session_id.startswith('guest-'):
            session_id = session_id[6:]
            logger.debug(f"Stripped guest prefix, using session_id: {session_id[:8]}...")
        
        ip = self._get_ip_address(request)
        ip_hash = self._hash_ip(ip)
        
        allowed, error = self._check_ip_rate_limit(ip_hash)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail={
                    'error': 'rate_limit_exceeded',
                    'message': error,
                    'action': 'signup_recommended'
                }
            )
        
        if session_id and session_id in self._sessions:
            session = self._sessions[session_id]
            
            if datetime.fromisoformat(session['expires_at']) < datetime.utcnow():
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
        
        self._sessions[new_session_id] = session
        
        logger.info(f"Created new guest session: {new_session_id}")
        
        return session
    
    def check_message_limit(self, session_id: str) -> Tuple[bool, Optional[Dict]]:
        if session_id not in self._sessions:
            return False, {
                'error': 'session_not_found',
                'message': 'Session not found. Please refresh the app.',
                'action': 'refresh_required'
            }
        
        session = self._sessions[session_id]
        
        if session['messages_sent'] >= session['messages_limit']:
            return False, {
                'error': 'message_limit_reached',
                'message': f"You've used all {session['messages_limit']} trial messages. Create a free account to continue!",
                'action': 'signup_required',
                'messages_sent': session['messages_sent'],
                'messages_limit': session['messages_limit']
            }
        
        return True, None
    
    def increment_message_count(self, session_id: str) -> Dict[str, Any]:
        if session_id not in self._sessions:
            raise HTTPException(status_code=404, detail="Session not found")
        
        session = self._sessions[session_id]
        session['messages_sent'] += 1
        session['last_message_at'] = datetime.utcnow().isoformat()
        
        logger.info(f"Guest session {session_id}: {session['messages_sent']}/{session['messages_limit']} messages used")
        
        return session
    
    def add_thread_to_session(self, session_id: str, thread_id: str):
        if session_id in self._sessions:
            if thread_id not in self._sessions[session_id]['thread_ids']:
                self._sessions[session_id]['thread_ids'].append(thread_id)
    
    def get_session_info(self, session_id: str) -> Optional[Dict[str, Any]]:
        if session_id not in self._sessions:
            return None
        
        session = self._sessions[session_id]
        messages_remaining = session['messages_limit'] - session['messages_sent']
        
        return {
            'is_guest': True,
            'messages_sent': session['messages_sent'],
            'messages_limit': session['messages_limit'],
            'messages_remaining': messages_remaining,
            'expires_at': session['expires_at'],
            'show_signup_prompt': messages_remaining <= 2
        }
    
    def cleanup_expired_sessions(self):
        now = datetime.utcnow()
        expired = []
        
        for session_id, session in self._sessions.items():
            if datetime.fromisoformat(session['expires_at']) < now:
                expired.append(session_id)
        
        for session_id in expired:
            del self._sessions[session_id]
            logger.info(f"Cleaned up expired guest session: {session_id}")
        
        return len(expired)

guest_session_service = GuestSessionService()
