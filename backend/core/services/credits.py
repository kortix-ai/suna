from decimal import Decimal
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, List, Any, Tuple
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.config import config, EnvMode
from core.billing.shared.config import FREE_TIER_INITIAL_CREDITS, TRIAL_ENABLED, get_tier_by_name
from core.utils.distributed_lock import DistributedLock
import asyncio

class CreditService:
    def __init__(self):
        self.db = DBConnection()
        self.cache = Cache
        self._client = None
    
    async def _get_client(self):
        if self._client is None:
            await self.db.initialize()
            self._client = await self.db.client
        return self._client
    
    async def check_and_refresh_daily_credits(self, user_id: str) -> Tuple[bool, Decimal]:
        try:
            client = await self._get_client()
            
            account_result = await client.from_('credit_accounts').select('tier, last_daily_refresh').eq('account_id', user_id).execute()
            
            if not account_result.data or len(account_result.data) == 0:
                return False, Decimal('0')
            
            account = account_result.data[0]
            tier_name = account.get('tier', 'free')
            
            tier = get_tier_by_name(tier_name)
            if not tier:
                return False, Decimal('0')
            
            daily_config = tier.daily_credit_config
            if not daily_config or not daily_config.get('enabled'):
                return False, Decimal('0')
            
            credit_amount = daily_config.get('amount', Decimal('0'))
            refresh_interval_hours = daily_config.get('refresh_interval_hours', 24)
            
            today = datetime.now(timezone.utc).date().isoformat()
            lock_key = f"daily_refresh:{user_id}:{today}"
            lock = DistributedLock(lock_key, timeout_seconds=60)
            
            acquired = await lock.acquire(wait=True, wait_timeout=30)
            if not acquired:
                logger.warning(f"[DAILY REFRESH] Failed to acquire lock for {user_id} on {today}")
                return False, Decimal('0')
            
            try:
                logger.info(f"[DAILY REFRESH] 🔒 Acquired lock for {user_id} on {today}")
                
                result = await client.rpc('atomic_daily_credit_refresh', {
                    'p_account_id': user_id,
                    'p_credit_amount': str(credit_amount),
                    'p_tier': tier_name,
                    'p_processed_by': 'api_request',
                    'p_refresh_interval_hours': refresh_interval_hours
                }).execute()
                
                if not result.data:
                    logger.error(f"[DAILY REFRESH] No data returned from atomic function for {user_id}")
                    return False, Decimal('0')
                
                response = result.data
                
                if response.get('duplicate_prevented'):
                    reason = response.get('reason', 'unknown')
                    logger.warning(
                        f"[DAILY REFRESH] ⛔ Duplicate prevented for {user_id} on {today}\n"
                        f"Reason: {reason}"
                    )
                    return False, Decimal('0')
                
                if response.get('success'):
                    credits_granted = Decimal(str(response.get('credits_granted', 0)))
                    new_balance = Decimal(str(response.get('new_balance', 0)))
                    old_expiring = Decimal(str(response.get('old_expiring', 0)))
                    
                    logger.info(
                        f"[DAILY REFRESH] ✅ Granted ${credits_granted} to {user_id}\n"
                        f"Tier: {tier_name}, Interval: {refresh_interval_hours}h\n"
                        f"Old expiring: ${old_expiring}, New balance: ${new_balance}"
                    )
                    
                    if self.cache:
                        await self.cache.invalidate(f"credit_balance:{user_id}")
                        await self.cache.invalidate(f"credit_summary:{user_id}")
                    
                    return True, credits_granted
                else:
                    reason = response.get('reason', 'unknown')
                    logger.info(f"[DAILY REFRESH] Not refreshed for {user_id}: {reason}")
                    return False, Decimal('0')
                    
            finally:
                await lock.release()
                logger.info(f"[DAILY REFRESH] 🔓 Released lock for {user_id} on {today}")
                
        except Exception as e:
            logger.error(f"[DAILY REFRESH] Failed for user {user_id}: {e}")
            return False, Decimal('0')
    
    async def get_balance(self, user_id: str, use_cache: bool = True) -> Decimal:
        cache_key = f"credit_balance:{user_id}"
        
        if use_cache and self.cache:
            cached = await self.cache.get(cache_key)
            if cached is not None:
                if isinstance(cached, (str, int, float)):
                    return Decimal(str(cached))
                else:
                    logger.warning(f"Invalid cache entry for {cache_key}: expected str/int/float, got {type(cached)}")
                    await self.cache.invalidate(cache_key)
        
        try:
            client = await self._get_client()
            result = await client.from_('credit_accounts').select('balance').eq('account_id', user_id).execute()
        except Exception as e:
            logger.error(f"Error fetching balance for user {user_id}: {e}")
            raise
        
        if result.data and len(result.data) > 0:
            balance = Decimal(str(result.data[0]['balance']))
        else:
            if config.ENV_MODE == EnvMode.LOCAL:
                logger.info(f"LOCAL mode: Creating user {user_id} with tier='none' (no free tier in local mode)")
                account_data = {
                    'account_id': user_id,
                    'balance': '0',
                    'tier': 'none',
                    'trial_status': 'none'
                }
                
                try:
                    await client.from_('credit_accounts').insert(account_data).execute()
                    logger.info(f"Successfully created tier='none' account for user {user_id} in LOCAL mode")
                except Exception as e:
                    logger.error(f"Failed to create account for user {user_id}: {e}")
                    raise
                
                balance = Decimal('0')
                
                await client.from_('credit_ledger').insert({
                    'account_id': user_id,
                    'amount': '0',
                    'type': 'initial',
                    'description': 'Account created - no free tier in local mode',
                    'balance_after': '0'
                }).execute()
            else:
                logger.info(f"Creating new user {user_id} - will auto-subscribe to free tier")
                
                account_data = {
                    'account_id': user_id,
                    'balance': '0',
                    'tier': 'none',
                    'trial_status': 'none'
                }
                
                try:
                    logger.info(f"Creating account for new user {user_id} with tier='none'")
                    
                    try:
                        test_data = {**account_data, 'last_grant_date': datetime.now(timezone.utc).isoformat()}
                        await client.from_('credit_accounts').insert(test_data).execute()
                        logger.info(f"Successfully created account for user {user_id}")
                    except Exception as e1:
                        logger.warning(f"Creating account without last_grant_date: {e1}")
                        await client.from_('credit_accounts').insert(account_data).execute()
                        logger.info(f"Successfully created minimal account for user {user_id}")
                    
                        
                except Exception as e:
                    logger.error(f"Failed to create account for user {user_id}: {e}")
                    raise
                
                balance = Decimal('0')
        
        if self.cache:
            await self.cache.set(cache_key, str(balance), ttl=300)
        
        return balance
    
    async def deduct_credits(self, user_id: str, amount: Decimal, description: str = None, reference_id: str = None, reference_type: str = None) -> Dict:
        try:
            client = await self._get_client()
            result = await client.rpc('deduct_credits', {
                'p_user_id': user_id,
                'p_amount': str(amount),
                'p_description': description or f'Credit usage: {amount}',
                'p_reference_id': reference_id,
                'p_reference_type': reference_type
            }).execute()
            
            if self.cache:
                await self.cache.invalidate(f"credit_balance:{user_id}")
            
            if result.data and len(result.data) > 0:
                row = result.data[0]
                success = row.get('success', False)
                new_balance = Decimal(str(row.get('new_balance', 0)))
                transaction_id = row.get('transaction_id')
                
                if success:
                    return {
                        'success': True,
                        'new_balance': new_balance,
                        'transaction_id': transaction_id
                    }
                else:
                    return {
                        'success': False,
                        'new_balance': new_balance,
                        'error': 'Insufficient credits'
                    }
            else:
                return {
                    'success': False,
                    'new_balance': await self.get_balance(user_id, use_cache=False),
                    'error': 'No result from deduct_credits'
                }
            
        except Exception as e:
            logger.error(f"Failed to deduct credits: {e}", user_id=user_id, amount=str(amount))
            return {
                'success': False,
                'error': str(e)
            }
    
    async def add_credits(
        self, 
        user_id: str, 
        amount: Decimal, 
        type: str = 'admin_grant',
        description: str = None,
        metadata: Dict = None
    ) -> Decimal:
        try:
            client = await self._get_client()
            result = await client.rpc('add_credits', {
                'p_user_id': user_id,
                'p_amount': str(amount),
                'p_description': description or f'Credit added: {amount}'
            }).execute()
            
            if result.data:
                new_balance = Decimal(str(result.data))
                
                if self.cache:
                    await self.cache.invalidate(f"credit_balance:{user_id}")
                
                logger.info(f"Added {amount} credits to user {user_id}. New balance: {new_balance}")
                return new_balance
            else:
                raise Exception("Failed to add credits")
                
        except Exception as e:
            logger.error(f"Failed to add credits: {e}", user_id=user_id, amount=str(amount))
            raise
    
    async def grant_tier_credits(self, user_id: str, price_id: str, tier_name: str) -> bool:
        try:
            from core.billing.shared.config import get_tier_by_price_id
            tier = get_tier_by_price_id(price_id)
            
            if not tier:
                logger.error(f"Unknown price_id: {price_id}")
                return False
            
            amount = Decimal(str(tier['credits']))
            
            client = await self._get_client()
            account_result = await client.from_('credit_accounts').select('last_grant_date').eq('account_id', user_id).execute()
            
            if account_result.data and len(account_result.data) > 0:
                last_grant = account_result.data[0].get('last_grant_date')
                if last_grant:
                    last_grant_date = datetime.fromisoformat(last_grant.replace('Z', '+00:00'))
                    if (datetime.now(timezone.utc) - last_grant_date) < timedelta(days=25):
                        logger.info(f"Credits already granted this month for user {user_id}")
                        return False
            
            result = await client.rpc('grant_tier_credits', {
                'p_user_id': user_id,
                'p_amount': str(amount),
                'p_tier': tier_name
            }).execute()
            
            if self.cache:
                await self.cache.invalidate(f"credit_balance:{user_id}")
            
            logger.info(f"Granted {amount} {tier_name} credits to user {user_id}")
            return bool(result.data)
            
        except Exception as e:
            logger.error(f"Failed to grant tier credits: {e}", user_id=user_id)
            return False
    
    async def get_ledger(
        self, 
        user_id: str, 
        limit: int = 50, 
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        client = await self._get_client()
        result = await client.from_('credit_ledger')\
            .select('*')\
            .eq('account_id', user_id)\
            .order('created_at', desc=True)\
            .limit(limit)\
            .offset(offset)\
            .execute()
        
        return result.data or []
    
    async def get_account_summary(self, user_id: str) -> Dict[str, Any]:
        client = await self._get_client()
        account_result = await client.from_('credit_accounts')\
            .select('*')\
            .eq('account_id', user_id)\
            .execute()
        
        if not account_result.data or len(account_result.data) == 0:
            await self.get_balance(user_id)
            return {
                'balance': str(FREE_TIER_INITIAL_CREDITS),
                'tier': 'free',
                'lifetime_granted': float(FREE_TIER_INITIAL_CREDITS),
                'lifetime_purchased': 0,
                'lifetime_used': 0,
                'last_grant_date': datetime.now(timezone.utc).isoformat()
            }
        
        ledger_result = await client.from_('credit_ledger')\
            .select('type, amount, description')\
            .eq('account_id', user_id)\
            .execute()
        
        lifetime_granted = Decimal('0')
        lifetime_purchased = Decimal('0')
        lifetime_used = Decimal('0')
        
        for entry in (ledger_result.data or []):
            amount = Decimal(str(entry['amount']))
            if entry['type'] in ['tier_grant', 'admin_grant', 'tier_upgrade']:
                lifetime_granted += amount
            elif entry['type'] == 'purchase':
                lifetime_purchased += amount
            elif entry['type'] == 'usage':
                lifetime_used += abs(amount)
        
        account = account_result.data[0]
        return {
            'balance': str(account['balance']),
            'tier': account['tier'],
            'lifetime_granted': float(lifetime_granted),
            'lifetime_purchased': float(lifetime_purchased),
            'lifetime_used': float(lifetime_used),
            'last_grant_date': account.get('last_grant_date')
        }

credit_service = CreditService() 