from typing import List, Dict, Any, Optional
from core.services.db import execute, serialize_row
from core.utils.logger import logger


async def get_user_accounts(user_id: str) -> List[Dict[str, Any]]:
    sql = """
    SELECT 
        a.id as account_id,
        a.name,
        a.slug,
        a.personal_account,
        a.created_at,
        a.updated_at,
        a.public_metadata,
        a.private_metadata,
        CASE 
            WHEN a.personal_account THEN 'owner'
            ELSE COALESCE(am.account_role, 'member')
        END as account_role
    FROM basejump.accounts a
    LEFT JOIN basejump.account_user am ON a.id = am.account_id AND am.user_id = :user_id
    WHERE 
        (a.primary_owner_user_id = :user_id)
        OR (am.user_id = :user_id)
    ORDER BY a.personal_account DESC, a.name ASC
    """
    
    rows = await execute(sql, {"user_id": user_id})
    
    if not rows:
        return []
    
    return [
        {
            "account_id": row["account_id"],
            "name": row["name"],
            "slug": row["slug"],
            "personal_account": row["personal_account"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "public_metadata": row.get("public_metadata", {}),
            "account_role": row["account_role"],
        }
        for row in rows
    ]
