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
                        'success': data.get('success', False),
                        'expiring_credits': data.get('expiring_credits', 0),
                        'non_expiring_credits': data.get('non_expiring_credits', 0),
                        'total_balance': data.get('total_balance', 0),
                        'duplicate_prevented': data.get('duplicate_prevented', False)
                    }
                else:
                    logger.error(f"[ATOMIC] No data returned from atomic_add_credits")
                    
            except Exception as e:
                logger.error(f"[ATOMIC] Failed to use atomic function, falling back to legacy: {e}")
                self.use_atomic_functions = False
        
        if stripe_event_id:
            existing_event = await client.from_('credit_ledger').select(
                'id, amount, balance_after'
            ).eq('stripe_event_id', stripe_event_id).execute()
            
            if existing_event.data:
                logger.warning(f"[IDEMPOTENCY] Duplicate Stripe event {stripe_event_id} prevented for {account_id}")
                return {
                    'success': True,
                    'message': 'Credit already added (Stripe event already processed)',
                    'amount': float(existing_event.data[0]['amount']),
                    'balance_after': float(existing_event.data[0]['balance_after']),
                    'duplicate_prevented': True
                }
        
        recent_window = datetime.now(timezone.utc) - timedelta(hours=24)
        recent_entries = await client.from_('credit_ledger').select(
            'id, created_at, amount, description, balance_after'
        ).eq('account_id', account_id).eq('amount', float(amount)).eq(
            'description', description
        ).gte('created_at', recent_window.isoformat()).execute()
        
        if recent_entries.data:
            logger.warning(f"[IDEMPOTENCY] Duplicate credit add detected for {account_id}: "
                         f"amount={amount}, description='{description}', "
                         f"found {len(recent_entries.data)} similar entries in last 24 hours")
            return {
                'success': True,
                'message': 'Credit already added (duplicate prevented)',
                'amount': float(amount),
                'balance_after': float(recent_entries.data[0]['balance_after']),
                'duplicate_prevented': True
            }
        
        result = await client.from_('credit_accounts').select(
            'expiring_credits, non_expiring_credits, balance, tier'
        ).eq('account_id', account_id).execute()
        
        if result.data:
            current = result.data[0]
            current_expiring = Decimal(str(current.get('expiring_credits', 0)))
            current_non_expiring = Decimal(str(current.get('non_expiring_credits', 0)))
            current_balance = Decimal(str(current.get('balance', 0)))
            tier = current.get('tier', 'none')
            
            current_sum = current_expiring + current_non_expiring
            if abs(current_sum - current_balance) > Decimal('0.01'):
                difference = current_sum - current_balance
                logger.critical(
                    f"[DATA CORRUPTION] Balance mismatch for {account_id}: "
                    f"expiring={current_expiring}, non_expiring={current_non_expiring}, "
                    f"sum={current_sum}, balance={current_balance}, difference={difference}"
                )
                
                if current_expiring >= difference:
                    current_expiring = current_expiring - difference
                else:
                    remainder = difference - current_expiring
                    current_expiring = Decimal('0')
                    current_non_expiring = max(Decimal('0'), current_non_expiring - remainder)
                
                adjusted_sum = current_expiring + current_non_expiring
                logger.info(f"[DATA CORRUPTION FIX] Adjusted balances for {account_id}: "
                          f"new_expiring={current_expiring}, new_non_expiring={current_non_expiring}")
        else:
            current_expiring = Decimal('0')
            current_non_expiring = Decimal('0')
            current_balance = Decimal('0')
            tier = 'none'

        if is_expiring:
            new_expiring = current_expiring + amount
            new_non_expiring = current_non_expiring
        else:
            new_expiring = current_expiring
            new_non_expiring = current_non_expiring + amount

        new_total = new_expiring + new_non_expiring
        
        expected_total = current_balance + amount
        if abs(new_total - expected_total) > Decimal('0.01'):
            new_total = expected_total
        
        if result.data:
            update_data = {
                'expiring_credits': float(new_expiring),
                'non_expiring_credits': float(new_non_expiring),
                'balance': float(new_total),
                'updated_at': datetime.now(timezone.utc).isoformat()
            }
            await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
        else:
            insert_data = {
                'account_id': account_id,
                'expiring_credits': float(new_expiring),
                'non_expiring_credits': float(new_non_expiring),
                'balance': float(new_total),
                'tier': tier
            }
            await client.from_('credit_accounts').insert(insert_data).execute()
        
        ledger_entry = {
            'account_id': account_id,
            'amount': float(amount),
            'balance_after': float(new_total),
            'type': type or ('tier_grant' if (is_expiring and type != 'admin_grant') else 'purchase'),
            'description': description,
            'is_expiring': is_expiring,
            'expires_at': expires_at.isoformat() if expires_at else None
        }
        
        if stripe_event_id:
            ledger_entry['stripe_event_id'] = stripe_event_id
        
        await client.from_('credit_ledger').insert(ledger_entry).execute()
        
        await Cache.invalidate(f"credit_balance:{account_id}")
        await Cache.invalidate(f"credit_summary:{account_id}")
        
        return {
            'success': True,
            'expiring_credits': float(new_expiring),
            'non_expiring_credits': float(new_non_expiring),
            'total_balance': float(new_total)
        }
    
    async def use_credits(
        self,
        account_id: str,
        amount: Decimal,
        description: Optional[str] = None,
        thread_id: Optional[str] = None,
        message_id: Optional[str] = None
    ) -> Dict:
        client = await self.db.client
        
        if self.use_atomic_functions:
            try:
                result = await client.rpc('atomic_use_credits', {
                    'p_account_id': account_id,
                    'p_amount': float(amount),
                    'p_description': description or 'Credit usage',
                    'p_thread_id': thread_id,
                    'p_message_id': message_id
                }).execute()
                
                if result.data:
                    data = result.data
                    
                    if data.get('success'):
                        logger.info(f"[ATOMIC] Deducted ${amount} credits from {account_id} atomically")
                        await Cache.invalidate(f"credit_balance:{account_id}")
                        
                        return {
                            'success': True,
                            'amount_deducted': data.get('amount_deducted', 0),
                            'from_expiring': data.get('from_expiring', 0),
                            'from_non_expiring': data.get('from_non_expiring', 0),
                            'new_expiring': data.get('new_expiring', 0),
                            'new_non_expiring': data.get('new_non_expiring', 0),
                            'new_total': data.get('new_total', 0)
                        }
                    else:
                        return {
                            'success': False,
                            'error': data.get('error', 'Unknown error'),
                            'required': data.get('required', 0),
                            'available': data.get('available', 0)
                        }
                        
            except Exception as e:
                logger.error(f"[ATOMIC] Failed to use atomic function for deduction: {e}")
                logger.critical(f"[CRITICAL] Atomic functions unavailable - credit deduction has race condition risk!")
                raise Exception("Atomic credit operations unavailable - refusing to process to prevent race conditions")
        
        logger.critical(f"[CRITICAL] Atomic functions disabled for account {account_id} - refusing credit deduction")
        raise Exception(
            "Atomic credit operations are disabled. Cannot safely deduct credits without race condition protection. "
            "Please ensure database atomic functions (atomic_use_credits) are available."
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
    
    async def get_balance(self, account_id: str) -> Dict:
        client = await self.db.client
        
        result = await client.from_('credit_accounts').select(
            'balance, expiring_credits, non_expiring_credits, tier'
        ).eq('account_id', account_id).execute()
        
        if result.data:
            data = result.data[0]
            return {
                'total': float(data.get('balance', 0)),
                'expiring': float(data.get('expiring_credits', 0)),
                'non_expiring': float(data.get('non_expiring_credits', 0)),
                'tier': data.get('tier', 'none')
            }
        
        return {
            'total': 0.0,
            'expiring': 0.0,
            'non_expiring': 0.0,
            'tier': 'none'
        }


credit_manager = CreditManager() 