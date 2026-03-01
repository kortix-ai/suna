from fastapi import HTTPException, Depends, Security, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional
from core.utils.logger import logger

# MIGRATED: from core.services.supabase import DBConnection
# Using Convex client for database operations
from core.services.convex_client import get_convex_client

security = HTTPBearer(auto_error=False)  # Don't auto-error, we handle both API key and Bearer

async def get_current_user(request: Request, credentials: Optional[HTTPAuthorizationCredentials] = Security(security)) -> dict:
    """
    Authenticate user via either X-API-Key header or Bearer token.
    Supports both authentication methods for all endpoints.
    """
    from core.utils.auth_utils import verify_and_get_user_id_from_jwt
    try:
        user_id = await verify_and_get_user_id_from_jwt(request)
        # Get token from credentials if available (for backwards compatibility)
        token = credentials.credentials if credentials else None
        return {"user_id": user_id, "token": token}
    except Exception as e:
        logger.error(f"Auth failed: {e}")
        raise HTTPException(status_code=401, detail="Invalid authentication")

def verify_role(required_role: str):
    async def role_checker(user: dict = Depends(get_current_user)) -> dict:
        """
        Verify user has required role for admin operations.
        
        Uses Convex to fetch user and check role.
        Currently uses tier as a proxy for role until a dedicated
        user_roles table is added to Convex.
        
        CONVEX ENDPOINTS NEEDED:
        1. GET /api/users/get?userId=... - Fetch user by ID
        2. GET /api/user-roles?userId=... - Fetch user's role (requires new table)
        
        CONVEX SCHEMA ADDITIONS NEEDED (schema.ts):
        userRoles: defineTable({
            userRoleId: v.string(),
            userId: v.string(),
            role: v.union(v.literal("user"), v.literal("admin"), v.literal("super_admin")),
            grantedAt: v.number(),
            grantedBy: v.optional(v.string()),
            metadata: v.optional(v.any()),
        })
        .index("by_userId", ["userId"])
        .index("by_role", ["role"])
        """
        user_role = 'user'  # Default role
        
        try:
            client = get_convex_client()
            
            # Attempt to fetch user from Convex to check their role/tier
            # NOTE: Requires Convex endpoint GET /api/users/get?userId=...
            # This endpoint does not exist yet in http.ts
            user_data = await client._request(
                "/api/users/get",
                "GET",
                params={"userId": user['user_id']}
            )
            
            if user_data:
                # Map tier to role for now (until proper user_roles table exists)
                tier = user_data.get('tier', 'free')
                
                tier_role_map = {
                    'enterprise': 'admin',
                    'pro': 'user',
                    'starter': 'user', 
                    'free': 'user'
                }
                user_role = tier_role_map.get(tier, 'user')
                
                # Check for admin by email domain
                email = user_data.get('email', '')
                if email:
                    admin_domains = ['admin.kortix.com', 'kortix.com']
                    if any(email.endswith(f'@{domain}') for domain in admin_domains):
                        user_role = 'admin'
                    
                    super_admin_emails = ['admin@kortix.com', 'superadmin@kortix.com']
                    if email.lower() in super_admin_emails:
                        user_role = 'super_admin'
                        
        except Exception as e:
            # If Convex query fails (endpoint not implemented yet), 
            # log warning and default to user role for security
            logger.warning(f"Could not fetch user role from Convex (endpoint may not exist): {e}")
            user_role = 'user'

        role_hierarchy = {'user': 0, 'admin': 1, 'super_admin': 2}

        if role_hierarchy.get(user_role, -1) < role_hierarchy.get(required_role, 999):
            raise HTTPException(status_code=403, detail=f"Requires {required_role} role")

        user['role'] = user_role
        return user

    return role_checker

require_admin = verify_role('admin')
require_super_admin = verify_role('super_admin') 
