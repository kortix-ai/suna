from typing import Dict, Optional, Tuple
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.cache import Cache


class CreditManager:
    def __init__(self):
        self.db = DBConnection()
    
    async def add_credits(
        self,
        account_id: str,
        amount: Decimal,
        is_expiring: bool = True,
        description: str = "Credit added",
        expires_at: Optional[datetime] = None,
        type: Optional[str] = None
    ) -> Dict:
        client = await self.db.client
        amount = Decimal(str(amount))
        
        recent_window = datetime.now(timezone.utc) - timedelta(seconds=20)
        recent_entries = await client.from_('credit_ledger').select(
            'id, created_at, amount, description'
        ).eq('account_id', account_id).eq('amount', float(amount)).eq(
            'description', description
        ).gte('created_at', recent_window.isoformat()).execute()
        
        if recent_entries.data:
            logger.warning(f"[IDEMPOTENCY] Potential duplicate credit add detected for {account_id}: "
                         f"amount={amount}, description='{description}', "
                         f"found {len(recent_entries.data)} similar entries in last 20 seconds")
            return {
                'success': True,
                'message': 'Credit already added (duplicate prevented)',
                'amount': float(amount),
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
                
                if current_expiring >= difference:
                    current_expiring = current_expiring - difference
                else:
                    remainder = difference - current_expiring
                    current_expiring = Decimal('0')
                    current_non_expiring = max(Decimal('0'), current_non_expiring - remainder)
                
                adjusted_sum = current_expiring + current_non_expiring
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
        
        result = await client.from_('credit_accounts').select(
            'expiring_credits, non_expiring_credits, balance'
        ).eq('account_id', account_id).execute()
        
        if not result.data:
            return {
                'success': False,
                'error': 'No credit account found',
                'required': float(amount),
                'available': 0
            }
        
        current = result.data[0]
        current_expiring = Decimal(str(current.get('expiring_credits', 0)))
        current_non_expiring = Decimal(str(current.get('non_expiring_credits', 0)))
        current_total = Decimal(str(current.get('balance', 0)))
        
        credit_sum = current_expiring + current_non_expiring
        if abs(credit_sum - current_total) > Decimal('0.01'):
            difference = current_total - credit_sum
            if difference > 0:
                current_non_expiring += difference
            else:
                if current_expiring >= abs(difference):
                    current_expiring -= abs(difference)
                else:
                    remainder = abs(difference) - current_expiring
                    current_expiring = Decimal('0')
                    current_non_expiring = max(Decimal('0'), current_non_expiring - remainder)
        
        if current_total < amount:
            return {
                'success': False,
                'error': 'Insufficient credits',
                'required': float(amount),
                'available': float(current_total)
            }
        
        if current_expiring >= amount:
            amount_from_expiring = amount
            amount_from_non_expiring = Decimal('0')
        else:
            amount_from_expiring = current_expiring
            amount_from_non_expiring = amount - current_expiring
        
        new_expiring = current_expiring - amount_from_expiring
        new_non_expiring = current_non_expiring - amount_from_non_expiring
        new_total = new_expiring + new_non_expiring
        
        await client.from_('credit_accounts').update({
            'expiring_credits': float(new_expiring),
            'non_expiring_credits': float(new_non_expiring),
            'balance': float(new_total),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', account_id).execute()
        
        await client.from_('credit_ledger').insert({
            'account_id': account_id,
            'amount': float(-amount),
            'balance_after': float(new_total),
            'type': 'usage',
            'description': description,
            'reference_id': thread_id or message_id,
            'metadata': {
                'thread_id': thread_id,
                'message_id': message_id,
                'from_expiring': float(amount_from_expiring),
                'from_non_expiring': float(amount_from_non_expiring)
            }
        }).execute()
        
        await Cache.invalidate(f"credit_balance:{account_id}")
        
        return {
            'success': True,
            'amount_deducted': float(amount),
            'from_expiring': float(amount_from_expiring),
            'from_non_expiring': float(amount_from_non_expiring),
            'new_expiring': float(new_expiring),
            'new_non_expiring': float(new_non_expiring),
            'new_total': float(new_total)
        }
    
    async def reset_expiring_credits(
        self,
        account_id: str,
        new_credits: Decimal,
        description: str = "Monthly credit renewal"
    ) -> Dict:
        client = await self.db.client

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
        
        await client.from_('credit_ledger').insert({
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
        }).execute()
        
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