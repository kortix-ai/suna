#!/usr/bin/env python3
"""
Suna Agent Installation Script for Individual Users

Simple script to install Suna agents for users by email address.

Usage:
    # Install Suna for a user
    python install_suna_for_user.py user@example.com
    
    # Install with replacement (if agent already exists)
    python install_suna_for_user.py user@example.com --replace

Examples:
    python install_suna_for_user.py john.doe@company.com
    python install_suna_for_user.py admin@example.org --replace
"""

import asyncio
import argparse
import sys
from pathlib import Path
from typing import Optional, Dict, Any

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.utils.suna_default_agent_service import SunaDefaultAgentService
from core.services.supabase import DBConnection
from core.utils.logger import logger


class SunaUserInstaller:
    def __init__(self):
        self.db = DBConnection()
        self.service = SunaDefaultAgentService(self.db)
    
    async def initialize(self):
        await self.db.initialize()
    
    async def get_account_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        try:
            client = await self.db.client
            try:
                result = await client.rpc('get_user_account_by_email', {
                    'email_input': email.lower()
                }).execute()
                
                if result.data:
                    return result.data
                    
            except Exception as e:
                logger.warning(f"RPC function not available: {e}")
                logger.info("Please run migration: 20250121_get_user_account_by_email.sql")
                logger.info("Falling back to name matching...")
            
            result = await client.schema('basejump').table('accounts').select(
                'id',
                'name', 
                'slug',
                'primary_owner_user_id'
            ).eq('personal_account', True).execute()
            
            if not result.data:
                return None

            email_prefix = email.split('@')[0].lower()
            
            for account in result.data:
                account_name = account.get('name') or ''
                account_slug = account.get('slug') or ''
                
                if account_name.lower() == email_prefix or \
                   account_slug.lower() == email_prefix:
                    return account
            
            email_prefix_normalized = email_prefix.replace('.', '').replace('-', '').replace('_', '')
            for account in result.data:
                account_name = (account.get('name') or '').lower().replace('.', '').replace('-', '').replace('_', '')
                account_slug = (account.get('slug') or '').lower().replace('.', '').replace('-', '').replace('_', '')
                
                if account_name == email_prefix_normalized or account_slug == email_prefix_normalized:
                    return account
            
            return None
            
        except Exception as e:
            logger.error(f"Error looking up account by email: {e}")
            raise
    
    async def install_for_email(self, email: str, replace: bool = False):
        print(f"🔍 Looking for account with email: {email}")
        
        account = await self.get_account_by_email(email)
        if not account:
            print(f"❌ No account found for email: {email}")
            print(f"   Make sure the user has signed up and has a personal account")
            return
        
        account_id = account['id']
        print(f"✅ Found account: {account['name']} ({account_id})")
        
        print(f"🚀 Installing Suna agent...")
        agent_id = await self.service.install_suna_agent_for_user(
            account_id, 
            replace_existing=replace
        )
        
        if agent_id:
            print(f"✅ Successfully installed Suna agent!")
            print(f"   🤖 Agent ID: {agent_id}")
            print(f"   👤 User: {email}")
            print(f"   📦 Account: {account_id}")
        else:
            print(f"❌ Failed to install Suna agent for {email}")



async def main():
    parser = argparse.ArgumentParser(
        description="Install Suna agent for a user by email",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    parser.add_argument('email', help='Email address of the user')
    parser.add_argument('--replace', action='store_true', 
                       help='Replace existing Suna agent if present')
    
    args = parser.parse_args()
    
    installer = SunaUserInstaller()
    
    try:
        await installer.initialize()
        await installer.install_for_email(args.email, args.replace)
            
    except KeyboardInterrupt:
        print("\n⚠️  Operation cancelled by user")
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        logger.error(f"Script error: {str(e)}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main()) 