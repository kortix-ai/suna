#!/usr/bin/env python3
"""
Suna Agent Installation Script for Individual Users

NOTE: This script is currently DISABLED pending Convex endpoint implementation.

Simple script to install Suna agents for users by email address or account ID.

Usage:
    # Install Suna for a user by email
    python install_suna_for_user.py user@example.com

    # Install Suna for a user by account ID
    python install_suna_for_user.py abc123-def456-ghi789

    # Install with replacement (if agent already exists)
    python install_suna_for_user.py user@example.com --replace

    # Explicitly specify account ID
    python install_suna_for_user.py abc123-def456-ghi789 --account-id

Examples:
    python install_suna_for_user.py john.doe@company.com
    python install_suna_for_user.py admin@example.org --replace
    python install_suna_for_user.py f47ac10b-58cc-4372-a567-0e02b2c3d479
    python install_suna_for_user.py f47ac10b-58cc-4372-a567-0e02b2c3d479 --replace

Convex Endpoints Required:
==========================
1. admin:getAccountByEmail - Account lookup by email
   Params: { email: string }
   Returns: { accountId, name, slug, primaryOwnerUserId }

2. admin:getUserAccountByEmail - Get user account by email (fallback)
   Params: { email: string }
   Returns: { accountId, ... }

3. admin:listPersonalAccounts - List all personal accounts (for email prefix matching)
   Params: {}
   Returns: [{ accountId, name, slug, ... }]

4. agents:create - Create agent with account association (already exists)
   Params: { accountId, agentConfig }
   Returns: { agentId, ... }
"""

import asyncio
import argparse
import sys
from pathlib import Path
from typing import Optional, Dict, Any

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.convex_client import get_convex_client
from core.utils.suna_default_agent_service import SunaDefaultAgentService
from core.utils.logger import logger


class SunaUserInstaller:
    def __init__(self):
        """
        Initialize the Suna user installer.

        Note: Disabled until Convex billing endpoints are implemented.
        """
        self.convex = get_convex_client()
        self.service = SunaDefaultAgentService()
    
    async def get_account_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        """
        Find account ID by email address.

        Requires Convex admin endpoint: admin:getAccountByEmail
        """
        # Try billing_customers lookup via Convex admin RPC
        result = await self.convex.admin_rpc("getAccountByEmail", {"email": email.lower()})
        if result:
            return result

        # Fallback: try RPC function via Convex admin RPC
        result = await self.convex.admin_rpc("getUserAccountByEmail", {"email": email.lower()})
        if result:
            return result

        # Last resort: match by email prefix to account name/slug
        all_accounts = await self.convex.admin_rpc("listPersonalAccounts", {})
        email_prefix = email.split('@')[0].lower()
        for account in all_accounts:
            if account['name'].lower() == email_prefix or account['slug'].lower() == email_prefix:
                return account

        return None
    
    async def install_for_email(self, email: str, replace: bool = False):
        print("="*60)
        print("⚠️  THIS SCRIPT IS DISABLED")
        print("="*60)
        print("This script requires Convex endpoints that are not yet implemented.")
        print("Required endpoints:")
        print("  - billing_customers/accounts schema queries")
        print("  - create_agent with account association")
        print("="*60)
        return
    
    async def install_for_account_id(self, account_id: str, replace: bool = False):
        print("="*60)
        print("⚠️  THIS SCRIPT IS DISABLED")
        print("="*60)
        print("This script requires Convex endpoints that are not yet implemented.")
        print("Required endpoints:")
        print("  - create_agent with account association")
        print("="*60)
        return


async def main():
    parser = argparse.ArgumentParser(
        description="Install Suna agent for a user by email or account ID",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    parser.add_argument('identifier', help='Email address or account ID (UUID) of the user')
    parser.add_argument('--replace', action='store_true', 
                       help='Replace existing Suna agent if present')
    parser.add_argument('--account-id', action='store_true',
                       help='Treat identifier as account ID instead of email')
    
    args = parser.parse_args()
    
    installer = SunaUserInstaller()
    
    try:
        if args.account_id:
            await installer.install_for_account_id(args.identifier, args.replace)
        elif '@' in args.identifier:
            await installer.install_for_email(args.identifier, args.replace)
        else:
            await installer.install_for_account_id(args.identifier, args.replace)
            
    except KeyboardInterrupt:
        print("\n⚠️  Operation cancelled by user")
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        logger.error(f"Script error: {str(e)}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())