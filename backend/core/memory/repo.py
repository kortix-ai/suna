from typing import Optional, List, Dict, Any
from core.services.db import execute, execute_one, execute_mutate
from core.utils.logger import logger


async def count_user_memories(account_id: str) -> int:
    sql = "SELECT COUNT(*) as count FROM user_memories WHERE account_id = :account_id"
    result = await execute_one(sql, {"account_id": account_id})
    return result["count"] if result else 0


async def get_all_memories(
    account_id: str,
    limit: int = 100,
    offset: int = 0,
    memory_type: Optional[str] = None
) -> Dict[str, Any]:
    params = {"account_id": account_id, "limit": limit, "offset": offset}
    
    if memory_type:
        sql = """
        SELECT *, COUNT(*) OVER() as total_count
        FROM user_memories
        WHERE account_id = :account_id AND memory_type = :memory_type
        ORDER BY created_at DESC
        LIMIT :limit OFFSET :offset
        """
        params["memory_type"] = memory_type
    else:
        sql = """
        SELECT *, COUNT(*) OVER() as total_count
        FROM user_memories
        WHERE account_id = :account_id
        ORDER BY created_at DESC
        LIMIT :limit OFFSET :offset
        """
    
    rows = await execute(sql, params)
    
    if not rows:
        return {"memories": [], "total": 0}
    
    total = rows[0]["total_count"] if rows else 0
    memories = [dict(row) for row in rows]
    
    return {"memories": memories, "total": total}


async def delete_memory(account_id: str, memory_id: str) -> bool:
    sql = """
    DELETE FROM user_memories 
    WHERE memory_id = :memory_id AND account_id = :account_id
    RETURNING memory_id
    """
    result = await execute_mutate(sql, {
        "memory_id": memory_id,
        "account_id": account_id
    })
    return len(result) > 0 if result else False


async def delete_all_memories(account_id: str) -> int:
    sql = """
    DELETE FROM user_memories 
    WHERE account_id = :account_id
    RETURNING memory_id
    """
    result = await execute_mutate(sql, {"account_id": account_id})
    return len(result) if result else 0
