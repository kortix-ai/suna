from typing import Dict, Optional, List
from datetime import datetime, timezone
from decimal import Decimal
import time

from core.utils.logger import logger
from core.utils.cache import Cache
from core.billing.shared.config import (
    get_tier_by_price_id, 
    get_price_type,
    get_plan_type
)
from core.billing.external.stripe import (
    generate_checkout_idempotency_key,
    generate_subscription_modify_idempotency_key,
    StripeAPIWrapper
)
from ..repositories.credit_account import CreditAccountRepository

class CheckoutService:
    def __init__(self):
        self.credit_account_repo = CreditAccountRepository()
    
    def generate_idempotency_key(self, account_id: str, price_id: str, commitment_type: Optional[str]) -> str:
        timestamp = int(time.time() * 1000)
        base_key = generate_checkout_idempotency_key(account_id, price_id, commitment_type)
        return f"{base_key}_{timestamp}"
    
    async def get_current_subscription_status(self, account_id: str) -> Dict:
        credit_account = await self.credit_account_repo.get_credit_account_with_subscription(account_id)
        
        if not credit_account or not credit_account.get('stripe_subscription_id'):
            return {
                'has_subscription': False,
                'subscription_id': None,
                'trial_status': None,
                'current_tier': None
            }
        
        return {
            'has_subscription': True,
            'subscription_id': credit_account['stripe_subscription_id'],
            'trial_status': credit_account.get('trial_status'),
            'current_tier': credit_account.get('tier')
        }
    
    def determine_checkout_flow(self, subscription_status: Dict) -> str:
        if not subscription_status['has_subscription']:
            return 'new_subscription'
        elif subscription_status['trial_status'] == 'active':
            return 'trial_conversion'
        else:
            return 'upgrade_existing'
    
    def build_subscription_metadata(
        self, 
        account_id: str, 
        commitment_type: Optional[str],
        flow_type: str,
        current_tier: Optional[str] = None,
        existing_subscription_id: Optional[str] = None
    ) -> Dict:
        base_metadata = {
            'account_id': account_id,
            'account_type': 'personal',
            'commitment_type': commitment_type or 'none'
        }
        
        if flow_type == 'trial_conversion':
            base_metadata.update({
                'converting_from_trial': 'true',
                'previous_tier': current_tier or 'trial',
                'previous_subscription_id': existing_subscription_id,
                'requires_cleanup': 'true'
            })
        elif flow_type == 'free_upgrade':
            base_metadata.update({
                'converting_from_free': 'true',
                'previous_tier': current_tier or 'free',
                'previous_subscription_id': existing_subscription_id,
                'requires_cleanup': 'true'
            })
        
        return base_metadata
    
    def build_checkout_response(
        self,
        session,
        flow_type: str = 'new_subscription',
        tier_info = None,
        tier_display_name: str = None
    ) -> Dict:
        from core.utils.config import config
        
        frontend_url = config.FRONTEND_URL
        client_secret = getattr(session, 'client_secret', None)
        checkout_param = f"client_secret={client_secret}" if client_secret else f"session_id={session.id}"
        fe_checkout_url = f"{frontend_url}/checkout?{checkout_param}"
        
        response = {
            'checkout_url': fe_checkout_url,
            'fe_checkout_url': fe_checkout_url,
            'session_id': session.id,
            'client_secret': client_secret,
        }
        
        if flow_type == 'trial_conversion' and tier_info:
            response.update({
                'converting_from_trial': True,
                'message': f'Converting from trial to {tier_display_name}. Your trial will end and the new plan will begin immediately upon payment.',
                'tier_info': {
                    'name': tier_info.name,
                    'display_name': tier_display_name,
                    'monthly_credits': float(tier_info.monthly_credits)
                }
            })
        elif flow_type == 'free_upgrade' and tier_info:
            response.update({
                'converting_from_free': True,
                'message': f'Upgrading from free tier to {tier_display_name}. Your free tier will end and the new plan will begin immediately upon payment.',
                'tier_info': {
                    'name': tier_info.name,
                    'display_name': tier_display_name,
                    'monthly_credits': float(tier_info.monthly_credits)
                }
            })
        
        return response
    
    async def invalidate_caches(self, account_id: str) -> None:
        cache_keys = [
            f"subscription_tier:{account_id}",
            f"credit_balance:{account_id}",
            f"credit_summary:{account_id}"
        ]
        
        for key in cache_keys:
            await Cache.invalidate(key)
