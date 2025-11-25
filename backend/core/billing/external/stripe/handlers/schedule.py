from fastapi import HTTPException, Request # type: ignore
from typing import Dict
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.distributed_lock import WebhookLock, RenewalLock, DistributedLock

class ScheduleHandler:
    @staticmethod
    async def handle_subscription_schedule_event(event, client):
        schedule = event.data.object
        subscription_id = schedule.get('subscription')
        schedule_id = schedule.id
        
        logger.info(f"[SCHEDULE] Processing {event.type} for schedule {schedule_id}, subscription {subscription_id}")
        
        if event.type == 'subscription_schedule.completed':
            account_id = schedule.get('metadata', {}).get('account_id')
            scheduled_tier = schedule.get('metadata', {}).get('target_tier')
            
            if account_id and scheduled_tier and schedule.get('metadata', {}).get('downgrade') == 'true':
                logger.info(f"[SCHEDULE COMPLETED] Downgrade schedule completed for {account_id}")
                
                downgrade_lock_key = f"schedule_complete_cleanup:{account_id}:{schedule_id}"
                downgrade_lock = DistributedLock(downgrade_lock_key, timeout_seconds=30)
                
                acquired = await downgrade_lock.acquire(wait=True, wait_timeout=15)
                if acquired:
                    try:
                        logger.info(f"[SCHEDULE COMPLETED] 🔒 Acquired lock for cleanup")
                        
                        recheck = await client.from_('credit_accounts').select(
                            'scheduled_tier_change, tier'
                        ).eq('account_id', account_id).execute()
                        
                        if recheck.data and recheck.data[0].get('scheduled_tier_change'):
                            await client.from_('credit_accounts').update({
                                'scheduled_tier_change': None,
                                'scheduled_tier_change_date': None,
                                'scheduled_price_id': None
                            }).eq('account_id', account_id).execute()
                            
                            await Cache.invalidate(f"subscription_tier:{account_id}")
                            
                            logger.info(f"[SCHEDULE COMPLETED] ✅ Cleared scheduled change fields for {account_id}")
                    finally:
                        await downgrade_lock.release()
        
        elif event.type == 'subscription_schedule.released':
            logger.info(f"[SCHEDULE RELEASED] Schedule {schedule_id} released (likely cancelled)")
