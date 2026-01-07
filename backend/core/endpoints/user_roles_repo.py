"""
User Roles Repository - Direct Postgres queries
"""
from typing import Optional, Dict, Any
from core.services.db import execute_one
from core.utils.logger import logger


async def get_user_admin_role(user_id: str) -> Dict[str, Any]:
    sql = """
    SELECT role 
    FROM user_roles 
    WHERE user_id = :user_id 
      AND role IN ('admin', 'super_admin')
    LIMIT 1
    """
    
    result = await execute_one(sql, {"user_id": user_id})
    
    if result:
        return {
            "isAdmin": True,
            "role": result["role"]
        }
    
    return {
        "isAdmin": False,
        "role": None
    }
