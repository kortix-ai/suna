from decimal import Decimal
from typing import Dict, List, Optional
from datetime import datetime, timezone
from core.services.supabase import DBConnection
from ..shared.config import get_tier_by_name
import logging

logger = logging.getLogger(__name__)

class RenewalService:
    def __init__(self):
        self.db = DBConnection()
    
    async def process_yearly_plan_refills(self) -> Dict:
        client = await self.db.client
        
        try:
            result = await client.rpc('process_monthly_refills').execute()
            
            if result.data:
                accounts_processed = len(result.data)
                successful = sum(1 for r in result.data if r.get('status') == 'success')
                failed = accounts_processed - successful
                
                logger.info(f"[YEARLY REFILL] Processed {accounts_processed} accounts: {successful} successful, {failed} failed")
                
                return {
                    'success': True,
                    'accounts_processed': accounts_processed,
                    'successful': successful,
                    'failed': failed,
                    'details': result.data
                }
            else:
                logger.info("[YEARLY REFILL] No accounts needed refill")
                return {
                    'success': True,
                    'accounts_processed': 0,
                    'successful': 0,
                    'failed': 0,
                    'details': []
                }
                
        except Exception as e:
            logger.error(f"[YEARLY REFILL] Error processing refills: {e}", exc_info=True)
            return {
                'success': False,
                'error': str(e),
                'accounts_processed': 0
            }
    
    async def grant_monthly_credits(
        self,
        account_id: str,
        tier_name: str,
        plan_type: str,
        period_start: datetime,
        period_end: datetime
    ) -> Dict:
        client = await self.db.client
        
        tier = get_tier_by_name(tier_name)
        if not tier:
            raise ValueError(f"Invalid tier: {tier_name}")
        
        # Only skip credit grant if monthly_refill is explicitly disabled (e.g., free tier)
        # Note: daily_credit_config is ADDITIONAL, not a replacement for monthly credits
        if not tier.monthly_refill_enabled:
            logger.info(f"[RENEWAL] Skipping monthly credit grant for {account_id} - tier {tier_name} has monthly_refill_enabled=False")
            return {
                'success': True,
                'account_id': account_id,
                'credits_granted': 0,
                'skipped': True,
                'reason': 'monthly_refill_disabled'
            }
        
        monthly_credits = tier.monthly_credits
        
        try:
            from core.billing.credits.manager import credit_manager
            
            result = await credit_manager.add_credits(
                account_id=account_id,
                amount=monthly_credits,
                is_expiring=True,
                description=f"{plan_type} plan monthly credit refill: {tier_name}",
                metadata={
                    'tier': tier_name,
                    'plan_type': plan_type,
                    'period_start': int(period_start.timestamp()),
                    'period_end': int(period_end.timestamp()),
                    'processed_by': 'renewal_service'
                }
            )
            
            next_grant = period_end
            await client.from_('credit_accounts').update({
                'next_credit_grant': next_grant.isoformat(),
                'last_grant_date': datetime.now(timezone.utc).isoformat(),
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).eq('account_id', account_id).execute()
            
            logger.info(f"[RENEWAL] Granted {monthly_credits} credits to {account_id} for {tier_name}")
            
            return {
                'success': True,
                'account_id': account_id,
                'credits_granted': float(monthly_credits),
                'next_grant': next_grant.isoformat()
            }
            
        except Exception as e:
            logger.error(f"[RENEWAL] Error granting credits to {account_id}: {e}", exc_info=True)
            raise
    
    async def update_plan_type(
        self,
        account_id: str,
        plan_type: str,
        billing_cycle_anchor: Optional[datetime] = None
    ) -> Dict:
        client = await self.db.client
        
        if plan_type not in ['monthly', 'yearly', 'yearly_commitment']:
            raise ValueError(f"Invalid plan_type: {plan_type}")
        
        update_data = {
            'plan_type': plan_type,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        if billing_cycle_anchor:
            update_data['billing_cycle_anchor'] = billing_cycle_anchor.isoformat()
        
        try:
            result = await client.from_('credit_accounts').update(
                update_data
            ).eq('account_id', account_id).execute()
            
            logger.info(f"[RENEWAL] Updated plan_type to {plan_type} for {account_id}")
            
            return {
                'success': True,
                'account_id': account_id,
                'plan_type': plan_type
            }
            
        except Exception as e:
            logger.error(f"[RENEWAL] Error updating plan_type for {account_id}: {e}", exc_info=True)
            raise
    
    async def get_accounts_due_for_refill(
        self,
        plan_type: str = 'yearly',
        limit: Optional[int] = None
    ) -> List[Dict]:
        client = await self.db.client
        
        query = client.from_('credit_accounts').select(
            'account_id, tier, plan_type, next_credit_grant, billing_cycle_anchor, stripe_subscription_id'
        ).eq('plan_type', plan_type).lte('next_credit_grant', datetime.now(timezone.utc).isoformat()).neq('tier', 'none').neq('tier', 'free').is_('next_credit_grant', 'not.null')
        
        if limit:
            query = query.limit(limit)
        
        result = await query.order('next_credit_grant', desc=False).execute()
        
        return result.data if result.data else []
    
    async def calculate_next_refill_date(
        self,
        account_id: str
    ) -> Optional[datetime]:
        client = await self.db.client
        
        result = await client.from_('credit_accounts').select(
            'next_credit_grant, billing_cycle_anchor, plan_type'
        ).eq('account_id', account_id).single().execute()
        
        if not result.data:
            return None
        
        account = result.data
        
        if account['plan_type'] != 'yearly':
            return None
        
        if account.get('next_credit_grant'):
            return datetime.fromisoformat(account['next_credit_grant'].replace('Z', '+00:00'))
        
        return None

renewal_service = RenewalService()
