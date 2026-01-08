from decimal import Decimal
from typing import Dict, List, Optional
from datetime import datetime, timezone
from core.billing import repo as billing_repo
from ..shared.config import get_tier_by_name
import logging

logger = logging.getLogger(__name__)


class RenewalService:
    async def process_yearly_plan_refills(self) -> Dict:
        try:
            result = await billing_repo.call_process_monthly_refills()
            
            if result:
                accounts_processed = len(result)
                successful = sum(1 for r in result if r.get('status') == 'success')
                failed = accounts_processed - successful
                
                logger.info(f"[YEARLY REFILL] Processed {accounts_processed} accounts: {successful} successful, {failed} failed")
                
                return {
                    'success': True,
                    'accounts_processed': accounts_processed,
                    'successful': successful,
                    'failed': failed,
                    'details': result
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
        tier = get_tier_by_name(tier_name)
        if not tier:
            raise ValueError(f"Invalid tier: {tier_name}")
        
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
            await billing_repo.update_credit_account(account_id, {
                'next_credit_grant': next_grant.isoformat(),
                'last_grant_date': datetime.now(timezone.utc).isoformat(),
                'updated_at': datetime.now(timezone.utc).isoformat()
            })
            
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
        if plan_type not in ['monthly', 'yearly', 'yearly_commitment']:
            raise ValueError(f"Invalid plan_type: {plan_type}")
        
        update_data = {
            'plan_type': plan_type,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        if billing_cycle_anchor:
            update_data['billing_cycle_anchor'] = billing_cycle_anchor.isoformat()
        
        try:
            await billing_repo.update_credit_account(account_id, update_data)
            
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
        return await billing_repo.get_accounts_due_for_refill(plan_type, limit)
    
    async def calculate_next_refill_date(
        self,
        account_id: str
    ) -> Optional[datetime]:
        result = await billing_repo.get_credit_account_for_refill(account_id)
        
        if not result:
            return None
        
        if result.get('plan_type') != 'yearly':
            return None
        
        if result.get('next_credit_grant'):
            return datetime.fromisoformat(result['next_credit_grant'].replace('Z', '+00:00'))
        
        return None


renewal_service = RenewalService()
