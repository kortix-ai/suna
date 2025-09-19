from datetime import datetime, timezone, timedelta
from decimal import Decimal
from core.services.supabase import DBConnection  
from core.credits import credit_service
from billing.config import get_monthly_credits
from core.utils.logger import logger

class CreditGrantJob:
    def __init__(self):
        self.db = DBConnection()
    
    async def initialize(self):
        await self.db.initialize()
        self.client = await self.db.client
        await credit_service.initialize()
    
    async def grant_monthly_credits(self):
        try:
            accounts = await self.client.from_('credit_accounts')\
                .select('user_id, tier, last_grant_date')\
                .neq('tier', 'free')\
                .execute()
            
            if not accounts.data:
                logger.info("No paid tier users to grant credits to")
                return
            
            current_month = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            granted = 0
            skipped = 0
            
            for account in accounts.data:
                user_id = account['user_id']
                tier = account['tier']
                last_grant = account.get('last_grant_date')
                
                if last_grant:
                    last_grant_date = datetime.fromisoformat(last_grant.replace('Z', '+00:00'))
                    if last_grant_date >= current_month:
                        logger.debug(f"User {user_id} already received credits this month")
                        skipped += 1
                        continue
                
                monthly_credits = get_monthly_credits(tier)
                if monthly_credits <= 0:
                    continue
                success = await credit_service.grant_tier_credits(
                    user_id=user_id,
                    tier=tier,
                    amount=monthly_credits
                )
                
                if success:
                    granted += 1
                    logger.info(f"Granted {monthly_credits} credits to user {user_id} (tier: {tier})")
                else:
                    logger.error(f"Failed to grant credits to user {user_id}")
            
            logger.info(f"Monthly credit grant complete. Granted: {granted}, Skipped: {skipped}")
            
        except Exception as e:
            logger.error(f"Error in monthly credit grant job: {e}")
            raise
    
    async def expire_old_credits(self):
        pass

credit_grant_job = CreditGrantJob() 