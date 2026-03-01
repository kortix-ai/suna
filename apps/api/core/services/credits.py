"""
Credit Service

This module provides credit management functionality including:
- Balance checking and daily credit refresh
- Credit deduction and addition
- Ledger operations and account summaries

MIGRATION STATUS:
- Caching: Active (no migration needed)
- Database operations: Migrated to Convex
"""
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, List, Any, Tuple
from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.config import config, EnvMode
from core.billing.shared.config import FREE_TIER_INITIAL_CREDITS, TRIAL_ENABLED, get_tier_by_name
from core.utils.distributed_lock import DistributedLock
import asyncio

# Using Convex client for credit operations
from core.services.convex_client import get_convex_client, NotFoundError, ConvexError


class CreditService:
    def __init__(self):
        self.convex = get_convex_client()
        self.cache = Cache

    async def check_and_refresh_daily_credits(self, user_id: str) -> Tuple[bool, Decimal]:
        """Check and perform daily credit refresh for a user.

        Args:
            user_id: The user's account ID

        Returns:
            Tuple of (refresh_performed, credits_granted)
        """
        try:
            logger.info(f"[DAILY REFRESH] Starting for {user_id}")

            # Use Convex endpoint for daily credit refresh
            result = await self.convex.refresh_daily_credits(user_id)

            if result and result.get('success'):
                credits_granted = Decimal(str(result.get('credits_granted', 0)))

                # Invalidate cache after refresh
                if self.cache:
                    await self.cache.invalidate(f"credit_balance:{user_id}")

                logger.info(f"[DAILY REFRESH] Completed for {user_id}: granted {credits_granted}")
                return True, credits_granted

            return False, Decimal('0')

        except NotFoundError:
            logger.warning(f"[DAILY REFRESH] No credit account found for {user_id}")
            return False, Decimal('0')
        except Exception as e:
            logger.error(f"[DAILY REFRESH] Failed for user {user_id}: {e}")
            return False, Decimal('0')

    async def get_balance(self, user_id: str, use_cache: bool = True) -> Decimal:
        """Get credit balance for a user.

        Args:
            user_id: The user's account ID
            use_cache: Whether to use cached balance

        Returns:
            Current credit balance as Decimal
        """
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
            # Use Convex endpoint for credit balance lookup
            result = await self.convex.get_credit_balance(user_id)

            if result:
                balance = result.get('balance', 0)
                return Decimal(str(balance))

            return Decimal('0')

        except NotFoundError:
            logger.debug(f"No credit account found for user {user_id}")
            return Decimal('0')
        except Exception as e:
            logger.error(f"Error fetching balance for user {user_id}: {e}")
            raise

    async def deduct_credits(
        self,
        user_id: str,
        amount: Decimal,
        description: str = None,
        reference_id: str = None,
        reference_type: str = None
    ) -> Dict:
        """Deduct credits from a user's account.

        Args:
            user_id: The user's account ID
            amount: Amount of credits to deduct
            description: Optional description for the transaction
            reference_id: Optional reference ID
            reference_type: Optional reference type

        Returns:
            Dict with success status, new balance, and optional error
        """
        try:
            # Use Convex endpoint for credit deduction
            result = await self.convex.deduct_credits(
                account_id=user_id,
                amount=int(amount),
                description=description,
                reference_id=reference_id,
                reference_type=reference_type
            )

            # Invalidate cache after deduction
            if self.cache:
                await self.cache.invalidate(f"credit_balance:{user_id}")

            if result and result.get('success'):
                return {
                    'success': True,
                    'new_balance': Decimal(str(result.get('new_balance', 0))),
                    'transaction_id': result.get('transaction_id')
                }

            return {
                'success': False,
                'new_balance': Decimal('0'),
                'error': result.get('error', 'Deduction failed') if result else 'Deduction failed'
            }

        except ConvexError as e:
            logger.error(f"Failed to deduct credits: {e}", user_id=user_id, amount=str(amount))
            return {
                'success': False,
                'error': str(e)
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
        """Add credits to a user's account.

        Args:
            user_id: The user's account ID
            amount: Amount of credits to add
            type: Type of credit addition (admin_grant, purchase, etc.)
            description: Optional description for the transaction
            metadata: Optional metadata dict

        Returns:
            New balance after addition
        """
        try:
            # Use Convex endpoint for credit addition
            result = await self.convex.add_credits(
                account_id=user_id,
                amount=int(amount),
                description=description,
                credit_type=type,
                metadata=metadata
            )

            # Invalidate cache after addition
            if self.cache:
                await self.cache.invalidate(f"credit_balance:{user_id}")

            if result:
                new_balance = Decimal(str(result.get('new_balance', 0)))
                logger.info(f"Added {amount} credits to {user_id}, new balance: {new_balance}")
                return new_balance

            raise Exception("Failed to add credits: no result returned")

        except Exception as e:
            logger.error(f"Failed to add credits: {e}", user_id=user_id, amount=str(amount))
            raise

    async def grant_tier_credits(self, user_id: str, price_id: str, tier_name: str) -> bool:
        """Grant tier-based credits to a user's account.

        Args:
            user_id: The user's account ID
            price_id: The Stripe price ID for tier lookup
            tier_name: Name of the tier

        Returns:
            True if credits were granted successfully
        """
        try:
            from core.billing.shared.config import get_tier_by_price_id
            tier = get_tier_by_price_id(price_id)

            if not tier:
                logger.error(f"Unknown price_id: {price_id}")
                return False

            # Use Convex endpoint for tier credit grant
            result = await self.convex.grant_tier_credits(
                account_id=user_id,
                tier_name=tier_name,
                price_id=price_id,
                grant_type="subscription"
            )

            # Invalidate cache after grant
            if self.cache:
                await self.cache.invalidate(f"credit_balance:{user_id}")

            if result and result.get('success'):
                credits_granted = result.get('credits_granted', 0)
                logger.info(f"Granted {credits_granted} tier credits to {user_id}")
                return True

            logger.warning(f"Tier credit grant returned unsuccessful for {user_id}")
            return False

        except Exception as e:
            logger.error(f"Failed to grant tier credits: {e}", user_id=user_id)
            return False

    async def get_ledger(
        self,
        user_id: str,
        limit: int = 50,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """Get credit transaction ledger for a user.

        Args:
            user_id: The user's account ID
            limit: Maximum number of transactions to return
            offset: Pagination offset

        Returns:
            List of credit transactions
        """
        try:
            # Use Convex endpoint for credit ledger
            result = await self.convex.get_credit_transactions(
                account_id=user_id,
                limit=limit,
                offset=offset
            )

            if result:
                return result

            return []

        except NotFoundError:
            logger.debug(f"No credit ledger found for user {user_id}")
            return []
        except Exception as e:
            logger.error(f"Failed to get credit ledger for {user_id}: {e}")
            return []

    async def get_account_summary(self, user_id: str) -> Dict[str, Any]:
        """Get comprehensive credit account summary for a user.

        Args:
            user_id: The user's account ID

        Returns:
            Dict with balance, tier, lifetime stats, etc.
        """
        try:
            # Use Convex endpoint for account summary
            result = await self.convex.get_credit_summary(user_id)

            if result:
                return {
                    'balance': result.get('balance', '0'),
                    'tier': result.get('tier', 'none'),
                    'lifetime_granted': result.get('lifetime_granted', 0),
                    'lifetime_purchased': result.get('lifetime_purchased', 0),
                    'lifetime_used': result.get('lifetime_used', 0),
                    'last_grant_date': result.get('last_grant_date'),
                    'expiring_credits': result.get('expiring_credits', 0),
                    'non_expiring_credits': result.get('non_expiring_credits', 0)
                }

            return {
                'balance': '0',
                'tier': 'none',
                'lifetime_granted': 0,
                'lifetime_purchased': 0,
                'lifetime_used': 0,
                'last_grant_date': None,
                'expiring_credits': 0,
                'non_expiring_credits': 0
            }

        except NotFoundError:
            logger.debug(f"No credit account found for user {user_id}")
            return {
                'balance': '0',
                'tier': 'none',
                'lifetime_granted': 0,
                'lifetime_purchased': 0,
                'lifetime_used': 0,
                'last_grant_date': None,
                'expiring_credits': 0,
                'non_expiring_credits': 0
            }
        except Exception as e:
            logger.error(f"Failed to get account summary for {user_id}: {e}")
            return {
                'balance': '0',
                'tier': 'none',
                'lifetime_granted': 0,
                'lifetime_purchased': 0,
                'lifetime_used': 0,
                'last_grant_date': None,
                'expiring_credits': 0,
                'non_expiring_credits': 0
            }


credit_service = CreditService()
