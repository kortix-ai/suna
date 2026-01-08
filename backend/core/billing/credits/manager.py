from typing import Dict, Optional, Tuple
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from core.utils.logger import logger
from core.utils.cache import Cache
from core.billing import repo as billing_repo
import uuid


class CreditManager:
    def __init__(self):
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
        amount = Decimal(str(amount))
        
        if self.use_atomic_functions:
            try:
                idempotency_key = f"{account_id}_{description}_{amount}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M')}"
                
                result = await billing_repo.atomic_add_credits(
                    account_id=account_id,
                    amount=float(amount),
                    is_expiring=is_expiring,
                    description=description,
                    expires_at=expires_at.isoformat() if expires_at else None,
                    credit_type=type,
                    stripe_event_id=stripe_event_id,
                    idempotency_key=idempotency_key
                )
                
                if result:
                    logger.info(f"[ATOMIC] Added ${amount} credits to {account_id} atomically")
                    
                    await Cache.invalidate(f"credit_balance:{account_id}")
                    await Cache.invalidate(f"credit_summary:{account_id}")
                    
                    return {
                        'success': True,
                        'ledger_id': result.get('ledger_id'),
                        'new_balance': Decimal(str(result.get('new_balance', 0))),
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
        if self.use_atomic_functions:
            try:
                result = await billing_repo.atomic_reset_expiring_credits(
                    account_id=account_id,
                    new_credits=float(new_credits),
                    description=description,
                    stripe_event_id=stripe_event_id
                )
                
                if result:
                    if result.get('success'):
                        logger.info(f"[ATOMIC] Reset expiring credits to ${new_credits} for {account_id} atomically")
                        
                        await Cache.invalidate(f"credit_balance:{account_id}")
                        await Cache.invalidate(f"credit_summary:{account_id}")
                        
                        return {
                            'success': True,
                            'new_expiring': result.get('new_expiring', 0),
                            'non_expiring': result.get('non_expiring', 0),
                            'total_balance': result.get('total_balance', 0)
                        }
                    else:
                        logger.error(f"[ATOMIC] Failed to reset credits: {result.get('error')}")
                        
            except Exception as e:
                logger.error(f"[ATOMIC] Failed to use atomic function for reset: {e}")
                self.use_atomic_functions = False

        # Fallback: manual reset
        account_data = await billing_repo.get_credit_account_balances(account_id)
        
        if account_data:
            current_balance = Decimal(str(account_data.get('balance', 0)))
            current_non_expiring = Decimal(str(account_data.get('non_expiring_credits', 0)))
            
            if current_balance <= current_non_expiring:
                actual_non_expiring = current_balance
            else:
                actual_non_expiring = current_non_expiring
        else:
            actual_non_expiring = Decimal('0')
            current_balance = Decimal('0')
        
        new_total = new_credits + actual_non_expiring
        
        await billing_repo.update_credit_account_balances(
            account_id=account_id,
            expiring_credits=float(new_credits),
            non_expiring_credits=float(actual_non_expiring),
            balance=float(new_total)
        )
        
        expires_at = datetime.now(timezone.utc).replace(day=1) + timedelta(days=32)
        expires_at = expires_at.replace(day=1)
        
        await billing_repo.insert_credit_ledger(
            account_id=account_id,
            amount=float(new_credits),
            balance_after=float(new_total),
            ledger_type='tier_grant',
            description=description,
            is_expiring=True,
            expires_at=expires_at.isoformat(),
            metadata={
                'renewal': True,
                'non_expiring_preserved': float(actual_non_expiring),
                'previous_balance': float(current_balance)
            },
            stripe_event_id=stripe_event_id
        )
        
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
        amount = Decimal(str(amount))
        
        if amount <= 0:
            raise ValueError("Amount must be positive")
        
        logger.info(f"[MANUAL] Adding ${amount} credits to {account_id}")
        
        result = await billing_repo.add_credits_and_update_account(
            account_id=account_id,
            amount=float(amount),
            ledger_type=type or 'credit',
            description=description,
            is_expiring=is_expiring,
            expires_at=expires_at.isoformat() if expires_at else None,
            stripe_event_id=stripe_event_id
        )
        
        await Cache.invalidate(f"credit_balance:{account_id}")
        await Cache.invalidate(f"credit_summary:{account_id}")
        
        new_balance = Decimal(str(result.get('new_balance', 0)))
        
        logger.info(f"[MANUAL] Successfully added ${amount} credits to {account_id}. New balance: ${new_balance}")
        
        return {
            'success': True,
            'ledger_id': result.get('ledger_id'),
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
        new_credits = Decimal(str(new_credits))
        
        logger.info(f"[MANUAL RESET] Replacing expiring credits with ${new_credits} for {account_id}")
        
        # First, expire all existing expiring credits
        await billing_repo.expire_existing_credits(account_id)
        
        # Add the new credits
        credit_id = str(uuid.uuid4())
        ledger_id = str(uuid.uuid4())
        
        # Insert new credit record
        credits_result = await billing_repo.insert_credit_record(
            credit_id=credit_id,
            account_id=account_id,
            amount=float(new_credits),
            is_expiring=True,
            expires_at=expires_at.isoformat() if expires_at else None,
            stripe_event_id=stripe_event_id
        )
        if not credits_result:
            raise Exception("Failed to insert new credit record")
        
        # Insert ledger record
        ledger_result = await billing_repo.insert_credit_ledger_with_credit_id(
            ledger_id=ledger_id,
            account_id=account_id,
            amount=float(new_credits),
            ledger_type='tier_upgrade',
            description=description,
            credit_id=credit_id,
            stripe_event_id=stripe_event_id
        )
        if not ledger_result:
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
                result = await billing_repo.atomic_use_credits(
                    account_id=account_id,
                    amount=float(amount),
                    description=description,
                    thread_id=thread_id,
                    message_id=message_id
                )
                
                if result:
                    new_balance = Decimal(str(result.get('new_total', 0)))
                    amount_deducted = amount
                    success = result.get('success', True)
                    
                    await Cache.invalidate(f"credit_balance:{account_id}")
                    await Cache.invalidate(f"credit_summary:{account_id}")
                    
                    logger.info(f"[ATOMIC] Deducted ${amount_deducted} from {account_id}. New balance: ${new_balance}")
                    
                    return {
                        'success': success,
                        'amount_deducted': amount_deducted,
                        'new_balance': new_balance,
                        'new_total': float(new_balance),
                        'from_expiring': float(result.get('from_expiring', 0)),
                        'from_non_expiring': float(result.get('from_non_expiring', 0)),
                        'transaction_id': result.get('transaction_id')
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
        amount = Decimal(str(amount))
        
        logger.info(f"[MANUAL] Deducting ${amount} from {account_id}")
        
        result = await billing_repo.deduct_credits_and_update_account(
            account_id=account_id,
            amount=float(amount),
            description=description,
            ledger_type=type,
            thread_id=thread_id,
            message_id=message_id
        )
        
        await Cache.invalidate(f"credit_balance:{account_id}")
        await Cache.invalidate(f"credit_summary:{account_id}")
        
        new_balance = Decimal(str(result.get('new_balance', 0)))
        
        logger.info(f"[MANUAL] Successfully deducted ${amount} from {account_id}. New balance: ${new_balance}")
        
        return {
            'success': True,
            'amount_deducted': amount,
            'new_balance': new_balance,
            'ledger_id': result.get('ledger_id'),
            'from_expiring': result.get('from_expiring', 0),
            'from_non_expiring': result.get('from_non_expiring', 0)
        }
    
    async def get_balance(self, account_id: str, use_cache: bool = True) -> Dict:
        cache_key = f"credit_balance:{account_id}"
        
        if use_cache:
            cached_balance = await Cache.get(cache_key)
            if cached_balance is not None:
                return cached_balance
        
        result = await billing_repo.get_credit_account_balance(account_id)
        
        if result:
            balance_data = {
                'total': result.get('balance', 0),
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
        
        account_data = await billing_repo.get_credit_account_balances(account_id)
        
        if account_data:
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
