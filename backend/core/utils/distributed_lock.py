import asyncio
import uuid
from typing import Optional
from datetime import datetime, timezone, timedelta
from contextlib import asynccontextmanager
from core.utils.logger import logger
from core.services.supabase import DBConnection

class DistributedLock:
    def __init__(self, lock_key: str, timeout_seconds: int = 300, holder_id: Optional[str] = None):
        self.lock_key = lock_key
        self.timeout_seconds = timeout_seconds
        self.holder_id = holder_id or f"{uuid.uuid4()}"
        self.db = DBConnection()
        self._acquired = False
    
    async def acquire(self, wait: bool = False, wait_timeout: int = 30) -> bool:
        client = await self.db.client
        
        start_time = datetime.now(timezone.utc)
        
        while True:
            try:
                result = await client.rpc('acquire_distributed_lock', {
                    'p_lock_key': self.lock_key,
                    'p_holder_id': self.holder_id,
                    'p_timeout_seconds': self.timeout_seconds
                }).execute()
                
                if result.data:
                    self._acquired = True
                    logger.info(f"[LOCK] Acquired lock: {self.lock_key} by {self.holder_id}")
                    return True
                
                if not wait:
                    logger.warning(f"[LOCK] Failed to acquire lock (no wait): {self.lock_key}")
                    return False
                
                elapsed = (datetime.now(timezone.utc) - start_time).total_seconds()
                if elapsed >= wait_timeout:
                    logger.warning(f"[LOCK] Lock acquisition timeout after {elapsed}s: {self.lock_key}")
                    return False
                
                await asyncio.sleep(0.5)
                
            except Exception as e:
                logger.error(f"[LOCK] Error acquiring lock {self.lock_key}: {e}")
                if not wait:
                    return False
                await asyncio.sleep(1)
    
    async def release(self) -> bool:
        if not self._acquired:
            return True
        
        try:
            client = await self.db.client
            result = await client.rpc('release_distributed_lock', {
                'p_lock_key': self.lock_key,
                'p_holder_id': self.holder_id
            }).execute()
            
            self._acquired = False
            logger.info(f"[LOCK] Released lock: {self.lock_key} by {self.holder_id}")
            return result.data if result.data is not None else False
            
        except Exception as e:
            logger.error(f"[LOCK] Error releasing lock {self.lock_key}: {e}")
            return False
    
    async def __aenter__(self):
        acquired = await self.acquire(wait=True, wait_timeout=30)
        if not acquired:
            raise RuntimeError(f"Failed to acquire lock: {self.lock_key}")
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.release()


@asynccontextmanager
async def distributed_lock(lock_key: str, timeout_seconds: int = 300, wait: bool = True):
    lock = DistributedLock(lock_key, timeout_seconds)
    try:
        acquired = await lock.acquire(wait=wait, wait_timeout=30)
        if not acquired:
            raise RuntimeError(f"Failed to acquire lock: {lock_key}")
        yield lock
    finally:
        await lock.release()


class RenewalLock:
    @staticmethod
    async def lock_renewal_processing(account_id: str, period_start: int) -> DistributedLock:
        lock_key = f"renewal:{account_id}:{period_start}"
        return DistributedLock(lock_key, timeout_seconds=300)
    
    @staticmethod
    async def check_and_mark_renewal_processed(
        account_id: str, 
        period_start: int,
        period_end: int,
        subscription_id: str,
        credits_granted: float,
        processed_by: str,
        stripe_event_id: Optional[str] = None
    ) -> bool:
        db = DBConnection()
        client = await db.client
        
        existing = await client.from_('renewal_processing').select('id, processed_by, credits_granted').eq(
            'account_id', account_id
        ).eq('period_start', period_start).execute()
        
        if existing.data:
            logger.warning(
                f"[RENEWAL BLOCK] Period {period_start} for account {account_id} "
                f"already processed by {existing.data[0]['processed_by']} "
                f"(granted ${existing.data[0]['credits_granted']})"
            )
            return False
        
        try:
            await client.from_('renewal_processing').insert({
                'account_id': account_id,
                'period_start': period_start,
                'period_end': period_end,
                'subscription_id': subscription_id,
                'processed_by': processed_by,
                'credits_granted': credits_granted,
                'stripe_event_id': stripe_event_id
            }).execute()
            
            logger.info(
                f"[RENEWAL TRACK] Marked period {period_start} as processed by {processed_by} "
                f"for account {account_id} (${credits_granted} credits)"
            )
            return True
            
        except Exception as e:
            logger.error(f"[RENEWAL TRACK] Failed to mark renewal processed: {e}")
            return False


class WebhookLock:
    @staticmethod
    async def check_and_mark_webhook_processing(
        event_id: str,
        event_type: str,
        payload: dict = None
    ) -> tuple[bool, Optional[str]]:
        db = DBConnection()
        client = await db.client
        
        existing = await client.from_('webhook_events').select('id, status, processed_at').eq(
            'event_id', event_id
        ).execute()
        
        if existing.data:
            event = existing.data[0]
            if event['status'] == 'completed':
                logger.info(f"[WEBHOOK] Event {event_id} already completed at {event['processed_at']}")
                return False, 'already_completed'
            elif event['status'] == 'processing':
                logger.warning(f"[WEBHOOK] Event {event_id} is currently being processed")
                return False, 'in_progress'
            elif event['status'] == 'failed':
                logger.info(f"[WEBHOOK] Retrying previously failed event {event_id}")
                await client.from_('webhook_events').update({
                    'status': 'processing',
                    'processing_started_at': datetime.now(timezone.utc).isoformat(),
                    'retry_count': event.get('retry_count', 0) + 1
                }).eq('id', event['id']).execute()
                return True, None
        else:
            try:
                await client.from_('webhook_events').insert({
                    'event_id': event_id,
                    'event_type': event_type,
                    'status': 'processing',
                    'processing_started_at': datetime.now(timezone.utc).isoformat(),
                    'payload': payload
                }).execute()
                logger.info(f"[WEBHOOK] Started processing new event {event_id}")
                return True, None
            except Exception as e:
                if 'duplicate key' in str(e).lower() or 'unique' in str(e).lower():
                    logger.warning(f"[WEBHOOK] Race condition detected for event {event_id}, another process started first")
                    return False, 'race_condition'
                raise
        
        return True, None
    
    @staticmethod
    async def mark_webhook_completed(event_id: str):
        db = DBConnection()
        client = await db.client
        
        await client.from_('webhook_events').update({
            'status': 'completed',
            'processed_at': datetime.now(timezone.utc).isoformat()
        }).eq('event_id', event_id).execute()
        
        logger.info(f"[WEBHOOK] Marked event {event_id} as completed")
    
    @staticmethod
    async def mark_webhook_failed(event_id: str, error_message: str):
        db = DBConnection()
        client = await db.client
        
        await client.from_('webhook_events').update({
            'status': 'failed',
            'error_message': error_message,
            'processed_at': datetime.now(timezone.utc).isoformat()
        }).eq('event_id', event_id).execute()
        
        logger.error(f"[WEBHOOK] Marked event {event_id} as failed: {error_message}")

