from typing import Optional, List, Dict, Any
from datetime import datetime, timezone, timedelta
from core.services.db import execute, execute_one, execute_mutate
from core.utils.logger import logger


async def validate_account_exists(account_id: str) -> bool:
    """Check if an account exists in basejump.accounts."""
    sql = "SELECT id FROM basejump.accounts WHERE id = :account_id LIMIT 1"
    result = await execute_one(sql, {"account_id": account_id})
    return result is not None


async def get_presence_session(session_id: str) -> Optional[Dict[str, Any]]:
    """Get a presence session by session_id."""
    sql = """
    SELECT session_id, account_id, active_thread_id, last_seen, 
           platform, device_info, client_timestamp, created_at, updated_at
    FROM user_presence_sessions 
    WHERE session_id = :session_id
    """
    result = await execute_one(sql, {"session_id": session_id})
    return dict(result) if result else None


async def upsert_presence_session(
    session_id: str,
    account_id: str,
    active_thread_id: Optional[str],
    platform: str,
    client_timestamp: Optional[str],
    device_info: Optional[Dict[str, Any]] = None
) -> bool:
    """Insert or update a presence session."""
    now = datetime.now(timezone.utc)
    
    sql = """
    INSERT INTO user_presence_sessions (
        session_id, account_id, active_thread_id, last_seen, 
        platform, device_info, client_timestamp, updated_at
    )
    VALUES (
        :session_id, :account_id, :active_thread_id, :last_seen,
        :platform, :device_info, :client_timestamp, :updated_at
    )
    ON CONFLICT (session_id) DO UPDATE SET
        active_thread_id = EXCLUDED.active_thread_id,
        last_seen = EXCLUDED.last_seen,
        platform = EXCLUDED.platform,
        device_info = EXCLUDED.device_info,
        client_timestamp = EXCLUDED.client_timestamp,
        updated_at = EXCLUDED.updated_at
    """
    
    try:
        await execute_mutate(sql, {
            "session_id": session_id,
            "account_id": account_id,
            "active_thread_id": active_thread_id,
            "last_seen": now,
            "platform": platform or "web",
            "device_info": device_info or {},
            "client_timestamp": client_timestamp or now.isoformat(),
            "updated_at": now
        })
        return True
    except Exception as e:
        logger.error(f"Error upserting presence session: {e}")
        return False


async def delete_presence_session(session_id: str) -> bool:
    """Delete a presence session."""
    sql = "DELETE FROM user_presence_sessions WHERE session_id = :session_id RETURNING session_id"
    result = await execute_mutate(sql, {"session_id": session_id})
    return len(result) > 0 if result else False


async def delete_stale_sessions(
    threshold_minutes: int = 5,
    account_id: Optional[str] = None
) -> int:
    """Delete stale presence sessions."""
    threshold = datetime.now(timezone.utc) - timedelta(minutes=threshold_minutes)
    
    if account_id:
        sql = """
        DELETE FROM user_presence_sessions 
        WHERE last_seen < :threshold AND account_id = :account_id
        RETURNING session_id
        """
        result = await execute_mutate(sql, {
            "threshold": threshold,
            "account_id": account_id
        })
    else:
        sql = """
        DELETE FROM user_presence_sessions 
        WHERE last_seen < :threshold
        RETURNING session_id
        """
        result = await execute_mutate(sql, {"threshold": threshold})
    
    return len(result) if result else 0


async def get_sessions_by_account_and_thread(
    account_id: str,
    thread_id: str
) -> List[Dict[str, Any]]:
    """Get all sessions for an account viewing a specific thread."""
    sql = """
    SELECT session_id, account_id, active_thread_id, last_seen, 
           platform, device_info, client_timestamp, created_at, updated_at
    FROM user_presence_sessions 
    WHERE account_id = :account_id AND active_thread_id = :thread_id
    """
    rows = await execute(sql, {"account_id": account_id, "thread_id": thread_id})
    return [dict(row) for row in rows] if rows else []

