#!/usr/bin/env python3
"""
Suna Default Agent Management Script (Simplified)

This script provides administrative functions for managing Suna default agents across all users.

NOTE: This script is currently DISABLED pending Convex endpoint implementation.
The Supabase database operations have been removed and need to be replaced with Convex calls.

Usage:
    # 🚀 MAIN COMMANDS
    python manage_suna_agents.py install-all          # Install Suna for all users who don't have it
    python manage_suna_agents.py stats                # Show Suna agent statistics
    python manage_suna_agents.py install-user <id>    # Install Suna for specific user

Examples:
    python manage_suna_agents.py install-all
    python manage_suna_agents.py stats
    python manage_suna_agents.py install-user 123e4567-e89b-12d3-a456-426614174000

Note: Sync is no longer needed - Suna agents automatically use the current configuration from config.py
"""

import asyncio
import argparse
import sys
import json
from pathlib import Path

# Add the backend directory to the path so we can import modules
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.convex_client import get_convex_client
from core.utils.suna_default_agent_service import SunaDefaultAgentService
from core.utils.logger import logger

# CONVEX ENDPOINTS REQUIRED (not yet implemented):
# ================================
# 1. List agents with filters:
#    convex.rpc("admin:listAgentsWithDefaults", {"isDefault": True, "limit": N})
#    Returns: [{ agentId, accountId, name, ... }]
#
# 2. Bulk agent installation:
#    convex.admin_rpc("bulkInstallAgents", {"agentConfig": {...}, "accountIds": [...]})
#    Returns: { installed: N, errors: [...] }
#
# 3. Agent statistics:
#    convex.admin_rpc("getAgentStats", {})
#    Returns: { totalAgents, defaultAgentsByAccount, ... }
#
# 4. Create agent with account association:
#    convex.rpc("agents:create", {...})
#
# NOTE: When endpoints are implemented, use:
#   from core.services.convex_client import get_convex_client
#   convex = get_convex_client()
#   result = await convex.rpc("endpoint:name", params)
#   admin_result = await convex.admin_rpc("admin:endpoint", params)
#
# TODO: SunaDefaultAgentService needs to be updated to use Convex
# See: core/utils/suna_default_agent_service.py


class SunaAgentManager:
    def __init__(self):
        """
        Initialize the Suna agent manager.

        Note: SunaDefaultAgentService is disabled until Convex endpoints are implemented.
        """
        # TODO: Enable when Convex billing endpoints are available
        # self.convex = get_convex_client()
        # self.service = SunaDefaultAgentService()
        self.convex = None
        self.service = None
    
    async def install_all_users(self):
        """Install Suna agent for all users who don't have it"""
        print("="*60)
        print("⚠️  THIS COMMAND IS DISABLED")
        print("="*60)
        print("This command requires Convex endpoints that are not yet implemented.")
        print("Required endpoints:")
        print("  - GET /api/admin/agents/list?isDefault=true")
        print("  - POST /api/admin/agents/bulk-install")
        print("="*60)

        # TODO: Implement when Convex admin endpoints are available
        # convex = get_convex_client()
        #
        # # Get all accounts without Suna default agent
        # agents = await convex.rpc("admin:listAgentsWithDefaults", {})
        # accounts_without_suna = find_accounts_without_suna(agents)
        #
        # # Bulk install Suna for those accounts
        # result = await convex.admin_rpc("bulkInstallAgents", {
        #     "agentConfig": SUNA_DEFAULT_CONFIG,
        #     "accountIds": accounts_without_suna
        # })
        return
        
    async def update_config_info(self):
        """Show information about Suna configuration (no sync needed)"""
        print("ℹ️  Suna Configuration Information")
        print("=" * 50)
        print("🔧 Suna agents automatically use the current configuration from config.py")
        print("📝 No sync needed - changes are applied immediately when agents run")
        print("💡 To update Suna behavior, simply modify backend/agent/suna/config.py")
        print("\n✅ All Suna agents are always up-to-date with your latest configuration!")
    
    async def install_user(self, account_id):
        """Install Suna agent for specific user"""
        print("="*60)
        print("⚠️  THIS COMMAND IS DISABLED")
        print("="*60)
        print("This command requires Convex endpoints that are not yet implemented.")
        print("Required endpoints:")
        print("  - POST /api/agents (exists but needs Suna defaults)")
        print("="*60)

        # TODO: Implement when Convex endpoints are available
        # convex = get_convex_client()
        #
        # # Check if user already has Suna
        # existing = await convex.rpc("agents:getDefault", {"accountId": account_id})
        # if existing:
        #     print(f"User {account_id} already has Suna")
        #     return
        #
        # # Create Suna agent for user
        # agent = await convex.rpc("agents:create", {
        #     "agentId": generate_id(),
        #     "accountId": account_id,
        #     "name": "Suna",
        #     "isDefault": True,
        #     ...SUNA_DEFAULT_CONFIG
        # })
        return
    
    async def replace_user_agent(self, account_id):
        """Replace Suna agent for specific user (in case of corruption)"""
        print("="*60)
        print("⚠️  THIS COMMAND IS DISABLED")
        print("="*60)
        print("This command requires Convex endpoints that are not yet implemented.")
        print("="*60)
        return
    
    async def show_stats(self):
        """Show Suna agent statistics"""
        print("="*60)
        print("⚠️  THIS COMMAND IS DISABLED")
        print("="*60)
        print("This command requires Convex endpoints that are not yet implemented.")
        print("Required endpoints:")
        print("  - GET /api/admin/agents/stats")
        print("="*60)

        # TODO: Implement when Convex admin endpoints are available
        # convex = get_convex_client()
        #
        # stats = await convex.admin_rpc("getAgentStats", {})
        # print("📊 Suna Default Agent Statistics")
        # print("=" * 50)
        # print(f"Total agents: {stats['totalAgents']}")
        # print(f"Default (Suna) agents: {stats['defaultAgents']}")
        # print(f"Accounts with Suna: {stats['accountsWitSuna']}")
        return


async def main():
    parser = argparse.ArgumentParser(
        description="Manage Suna default agents across all users (Simplified)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Available commands')
    
    # Main commands
    subparsers.add_parser('install-all', help='Install Suna agent for all users who don\'t have it')
    subparsers.add_parser('stats', help='Show Suna agent statistics')
    subparsers.add_parser('config-info', help='Show information about Suna configuration')
    
    # User-specific commands
    install_user_parser = subparsers.add_parser('install-user', help='Install Suna agent for specific user')
    install_user_parser.add_argument('account_id', help='Account ID to install Suna for')
    
    replace_user_parser = subparsers.add_parser('replace-user', help='Replace Suna agent for specific user (if corrupted)')
    replace_user_parser.add_argument('account_id', help='Account ID to replace Suna for')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return
    
    manager = SunaAgentManager()
    
    try:
        if args.command == 'install-all':
            await manager.install_all_users()
        elif args.command == 'stats':
            await manager.show_stats()
        elif args.command == 'config-info':
            await manager.update_config_info()
        elif args.command == 'install-user':
            await manager.install_user(args.account_id)
        elif args.command == 'replace-user':
            await manager.replace_user_agent(args.account_id)
        else:
            parser.print_help()
            
    except KeyboardInterrupt:
        print("\n⚠️  Operation cancelled by user")
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        logger.error(f"Script error: {str(e)}")


if __name__ == "__main__":
    asyncio.run(main())