from typing import Dict, Optional, Tuple
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.cache import Cache
import uuid


class CreditManager:
    def __init__(self):
        self.db = DBConnection()
        self.use_atomic_functions = True
    
    async def add_credits(
        self,
        account_id: str,
        amount: Decimal,
        is_expiring: bool = True,
        description: str = "Credit added",
        expires_at: Optional[datetime] = None,
        type: Optional[str] = None,
        stripe_event_id: Optional[str] = None
    ) -> Dict:
        client = await self.db.client
        amount = Decimal(str(amount))
        
        if self.use_atomic_functions:
            try:
                idempotency_key = f"{account_id}_{description}_{amount}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M')}"
                
                result = await client.rpc('atomic_add_credits', {
                    'p_account_id': account_id,
                    'p_amount': float(amount),
                    'p_is_expiring': is_expiring,
                    'p_description': description,
                    'p_expires_at': expires_at.isoformat() if expires_at else None,
                    'p_type': type,
                    'p_stripe_event_id': stripe_event_id,
                    'p_idempotency_key': idempotency_key
                }).execute()
                
                if result.data:
                    data = result.data
                    logger.info(f"[ATOMIC] Added ${amount} credits to {account_id} atomically")
                    
                    await Cache.invalidate(f"credit_balance:{account_id}")
                    await Cache.invalidate(f"credit_summary:{account_id}")
                    
                    return {
                        'success': True,
                        'credit_id': data.get('credit_id'),
                        'ledger_id': data.get('ledger_id'),
                        'new_balance': Decimal(str(data.get('new_balance', 0))),
                        'amount_added': amount
                    }
                else:
                    raise Exception("No data returned from atomic_add_credits")
                    
            except Exception as e:
                logger.error(f"[ATOMIC] Failed to add credits atomically: {e}")
                
                if "duplicate key" in str(e).lower():
                    logger.info(f"[ATOMIC] Duplicate credit addition detected for {account_id}, returning success")
                    balance_info = await self.get_balance(account_id)
                    return {
                        'success': True,
                        'duplicate': True,
                        'new_balance': Decimal(str(balance_info.get('total', 0))),
                        'amount_added': amount
                    }
                
                logger.warning("[ATOMIC] Falling back to manual transaction")
        
        return await self._add_credits_manual(
            account_id, amount, is_expiring, description, expires_at, type, stripe_event_id
        )
    
    async def reset_expiring_credits(
        self,
        account_id: str,
        new_credits: Decimal,
        description: str = "Monthly credit renewal",
        stripe_event_id: Optional[str] = None
    ) -> Dict:
        client = await self.db.client
        if self.use_atomic_functions:
            try:
                result = await client.rpc('atomic_reset_expiring_credits', {
                    'p_account_id': account_id,
                    'p_new_credits': float(new_credits),
                    'p_description': description,
                    'p_stripe_event_id': stripe_event_id
                }).execute()
                
                if result.data:
                    data = result.data
                    
                    if data.get('success'):
                        logger.info(f"[ATOMIC] Reset expiring credits to ${new_credits} for {account_id} atomically")
                        
                        await Cache.invalidate(f"credit_balance:{account_id}")
                        await Cache.invalidate(f"credit_summary:{account_id}")
                        
                        return {
                            'success': True,
                            'new_expiring': data.get('new_expiring', 0),
                            'non_expiring': data.get('non_expiring', 0),
                            'total_balance': data.get('total_balance', 0)
                        }
                    else:
                        logger.error(f"[ATOMIC] Failed to reset credits: {data.get('error')}")
                        
            except Exception as e:
                logger.error(f"[ATOMIC] Failed to use atomic function for reset: {e}")
                self.use_atomic_functions = False

        result = await client.from_('credit_accounts').select(
            'balance, expiring_credits, non_expiring_credits'
        ).eq('account_id', account_id).execute()
        
        if result.data:
            current = result.data[0]
            current_balance = Decimal(str(current.get('balance', 0)))
            current_expiring = Decimal(str(current.get('expiring_credits', 0)))
            current_non_expiring = Decimal(str(current.get('non_expiring_credits', 0)))
            
            if current_balance <= current_non_expiring:
                actual_non_expiring = current_balance
            else:
                actual_non_expiring = current_non_expiring
        else:
            actual_non_expiring = Decimal('0')
            current_balance = Decimal('0')
        
        new_total = new_credits + actual_non_expiring
        
        await client.from_('credit_accounts').update({
            'expiring_credits': float(new_credits),
            'non_expiring_credits': float(actual_non_expiring),
            'balance': float(new_total),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', account_id).execute()
        
        expires_at = datetime.now(timezone.utc).replace(day=1) + timedelta(days=32)
        expires_at = expires_at.replace(day=1)
        
        ledger_entry = {
            'account_id': account_id,
            'amount': float(new_credits),
            'balance_after': float(new_total),
            'type': 'tier_grant',
            'description': description,
            'is_expiring': True,
            'expires_at': expires_at.isoformat(),
            'metadata': {
                'renewal': True,
                'non_expiring_preserved': float(actual_non_expiring),
                'previous_balance': float(current_balance)
            }
        }
        
        if stripe_event_id:
            ledger_entry['stripe_event_id'] = stripe_event_id
        
        await client.from_('credit_ledger').insert(ledger_entry).execute()
        
        await Cache.invalidate(f"credit_balance:{account_id}")
        await Cache.invalidate(f"credit_summary:{account_id}")
        
        return {
            'success': True,
            'new_expiring': float(new_credits),
            'non_expiring': float(actual_non_expiring),
            'total_balance': float(new_total)
        }
    
    async def _add_credits_manual(
        self,
        account_id: str,
        amount: Decimal,
        is_expiring: bool,
        description: str,
        expires_at: Optional[datetime],
        type: Optional[str],
        stripe_event_id: Optional[str]
    ) -> Dict:
        client = await self.db.client
        amount = Decimal(str(amount))
        
        if amount <= 0:
            raise ValueError("Amount must be positive")
        
        credit_id = str(uuid.uuid4())
        ledger_id = str(uuid.uuid4())
        
        credits_data = {
            'id': credit_id,
            'account_id': account_id,
            'amount': float(amount),
            'is_expiring': is_expiring,
            'expires_at': expires_at.isoformat() if expires_at else None,
        }
        
        if stripe_event_id:
            credits_data['stripe_event_id'] = stripe_event_id
        
        ledger_data = {
            'id': ledger_id,
            'account_id': account_id,
            'amount': float(amount),
            'type': type or 'credit',
            'description': description,
            'credit_id': credit_id,
        }
        
        if stripe_event_id:
            ledger_data['stripe_event_id'] = stripe_event_id
        
        logger.info(f"[MANUAL] Adding ${amount} credits to {account_id}")
        
        credits_result = await client.from_('credits').insert(credits_data).execute()
        if not credits_result.data:
            raise Exception("Failed to insert credit record")
        
        ledger_result = await client.from_('credit_ledger').insert(ledger_data).execute()
        if not ledger_result.data:
            raise Exception("Failed to insert ledger record")
        
        await Cache.invalidate(f"credit_balance:{account_id}")
        await Cache.invalidate(f"credit_summary:{account_id}")
        
        balance_info = await self.get_balance(account_id)
        new_balance = Decimal(str(balance_info.get('total', 0)))
        
        logger.info(f"[MANUAL] Successfully added ${amount} credits to {account_id}. New balance: ${new_balance}")
        
        return {
            'success': True,
            'credit_id': credit_id,
            'ledger_id': ledger_id,
            'new_balance': new_balance,
            'amount_added': amount
        }
    
    async def _reset_expiring_credits_manual(
        self,
        account_id: str,
        new_credits: Decimal,
        description: str,
        expires_at: Optional[datetime],
        stripe_event_id: Optional[str]
    ) -> Dict:
        """Manually replace all existing expiring credits with new amount"""
        client = await self.db.client
        new_credits = Decimal(str(new_credits))
        
        logger.info(f"[MANUAL RESET] Replacing expiring credits with ${new_credits} for {account_id}")
        
        # First, expire all existing expiring credits
        current_time = datetime.now(timezone.utc)
        await client.from_('credits').update({
            'expires_at': current_time.isoformat(),
            'is_expired': True
        }).eq('account_id', account_id).eq('is_expiring', True).is_('is_expired', 'null').execute()
        
        # Add the new credits
        credit_id = str(uuid.uuid4())
        ledger_id = str(uuid.uuid4())
        
        credits_data = {
            'id': credit_id,
            'account_id': account_id,
            'amount': float(new_credits),
            'is_expiring': True,
            'expires_at': expires_at.isoformat() if expires_at else None,
        }
        
        if stripe_event_id:
            credits_data['stripe_event_id'] = stripe_event_id
        
        ledger_data = {
            'id': ledger_id,
            'account_id': account_id,
            'amount': float(new_credits),
            'type': 'tier_upgrade',
            'description': description,
            'credit_id': credit_id,
        }
        
        if stripe_event_id:
            ledger_data['stripe_event_id'] = stripe_event_id
        
        # Insert new credit record
        credits_result = await client.from_('credits').insert(credits_data).execute()
        if not credits_result.data:
            raise Exception("Failed to insert new credit record")
        
        # Insert ledger record
        ledger_result = await client.from_('credit_ledger').insert(ledger_data).execute()
        if not ledger_result.data:
            raise Exception("Failed to insert new ledger record")
        
        await Cache.invalidate(f"credit_balance:{account_id}")
        await Cache.invalidate(f"credit_summary:{account_id}")
        
        balance_info = await self.get_balance(account_id)
        new_balance = Decimal(str(balance_info.get('total', 0)))
        
        logger.info(f"[MANUAL RESET] Successfully reset expiring credits to ${new_credits} for {account_id}. New balance: ${new_balance}")
        
        return {
            'success': True,
            'credit_id': credit_id,
            'ledger_id': ledger_id,
            'new_balance': new_balance,
            'amount_reset': new_credits
        }
    
    async def deduct_credits(
        self,
        account_id: str,
        amount: Decimal,
        description: str = "Credit deducted",
        type: str = 'usage',
        message_id: Optional[str] = None,
        thread_id: Optional[str] = None
    ) -> Dict:
        client = await self.db.client
        amount = Decimal(str(amount))
        
        if amount <= 0:
            logger.warning(f"[DEDUCTION] Zero or negative amount {amount} for {account_id}, skipping")
            balance_info = await self.get_balance(account_id)
            return {
                'success': True,
                'amount_deducted': Decimal('0'),
                'new_balance': Decimal(str(balance_info.get('total', 0))),
                'message': 'No deduction needed for zero amount'
            }
        
        if self.use_atomic_functions:
            try:
                metadata = {}
                if message_id:
                    metadata['message_id'] = message_id
                if thread_id:
                    metadata['thread_id'] = thread_id
                
                result = await client.rpc('atomic_use_credits', {
                    'p_account_id': account_id,
                    'p_amount': float(amount),
                    'p_description': description,
                    'p_thread_id': thread_id,
                    'p_message_id': message_id
                }).execute()
                
                if result.data:
                    data = result.data[0] if isinstance(result.data, list) else result.data
                    new_balance = Decimal(str(data.get('new_total', 0)))
                    amount_deducted = amount
                    success = data.get('success', True)
                    
                    await Cache.invalidate(f"credit_balance:{account_id}")
                    await Cache.invalidate(f"credit_summary:{account_id}")
                    
                    logger.info(f"[ATOMIC] Deducted ${amount_deducted} from {account_id}. New balance: ${new_balance}")
                    
                    return {
                        'success': success,
                        'amount_deducted': amount_deducted,
                        'new_balance': new_balance,
                        'new_total': float(new_balance),
                        'from_expiring': float(data.get('from_expiring', 0)),
                        'from_non_expiring': float(data.get('from_non_expiring', 0)),
                        'transaction_id': data.get('transaction_id')
                    }
                else:
                    raise Exception("No data returned from atomic_deduct_credits")
                    
            except Exception as e:
                logger.error(f"[ATOMIC] Failed to deduct credits atomically: {e}")
                logger.warning("[ATOMIC] Falling back to manual transaction")
        
        return await self._deduct_credits_manual(
            account_id, amount, description, type, message_id, thread_id
        )
    
    async def _deduct_credits_manual(
        self,
        account_id: str,
        amount: Decimal,
        description: str,
        type: str,
        message_id: Optional[str],
        thread_id: Optional[str]
    ) -> Dict:
        client = await self.db.client
        amount = Decimal(str(amount))
        
        logger.info(f"[MANUAL] Deducting ${amount} from {account_id}")
        
        balance_info = await self.get_balance(account_id)
        current_balance = Decimal(str(balance_info.get('total', 0)))
        
        if current_balance <= 0:
            logger.warning(f"[MANUAL] Account {account_id} has non-positive balance ${current_balance}")
        
        ledger_id = str(uuid.uuid4())
        ledger_data = {
            'id': ledger_id,
            'account_id': account_id,
            'amount': -float(amount),
            'type': type,
            'description': description,
        }
        
        metadata = {}
        if message_id:
            metadata['message_id'] = message_id
        if thread_id:
            metadata['thread_id'] = thread_id
        if metadata:
            ledger_data['metadata'] = metadata
        
        ledger_result = await client.from_('credit_ledger').insert(ledger_data).execute()
        if not ledger_result.data:
            raise Exception("Failed to insert deduction ledger record")
        
        await Cache.invalidate(f"credit_balance:{account_id}")
        await Cache.invalidate(f"credit_summary:{account_id}")
        
        new_balance_info = await self.get_balance(account_id)
        new_balance = Decimal(str(new_balance_info.get('total', 0)))
        
        logger.info(f"[MANUAL] Successfully deducted ${amount} from {account_id}. New balance: ${new_balance}")
        
        return {
            'success': True,
            'amount_deducted': amount,
            'new_balance': new_balance,
            'ledger_id': ledger_id
        }
    
    async def get_balance(self, account_id: str, use_cache: bool = True) -> Dict:
        cache_key = f"credit_balance:{account_id}"
        
        if use_cache:
            cached_balance = await Cache.get(cache_key)
            if cached_balance is not None:
                return cached_balance
        
        client = await self.db.client
        balance_result = await client.from_('credit_accounts').select('balance').eq('account_id', account_id).execute()
        
        if balance_result.data and len(balance_result.data) > 0:
            balance = balance_result.data[0]['balance']
            balance_data = {
                'total': balance,
                'account_id': account_id
            }
        else:
            balance_data = {
                'total': 0,
                'account_id': account_id
            }
        
        await Cache.set(cache_key, balance_data, ttl=300)
        return balance_data
    
    async def get_credit_summary(self, account_id: str) -> Dict:
        cache_key = f"credit_summary:{account_id}"
        cached_summary = await Cache.get(cache_key)
        if cached_summary is not None:
            return cached_summary
        
        client = await self.db.client
        
        account_result = await client.from_('credit_accounts').select(
            'balance, expiring_credits, non_expiring_credits'
        ).eq('account_id', account_id).execute()
        
        if account_result.data and len(account_result.data) > 0:
            account_data = account_result.data[0]
            summary_data = {
                'total_balance': account_data.get('balance', 0),
                'expiring_balance': account_data.get('expiring_credits', 0),
                'non_expiring_balance': account_data.get('non_expiring_credits', 0),
                'monthly_usage': 0,
                'account_id': account_id
            }
            
        else:
            summary_data = {
                'total_balance': 0,
                'expiring_balance': 0,
                'non_expiring_balance': 0,
                'monthly_usage': 0,
                'account_id': account_id
            }
        
        await Cache.set(cache_key, summary_data, ttl=300)
        return summary_data

credit_manager = CreditManager()
