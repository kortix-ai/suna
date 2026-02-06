"""
Kortix Tools Billing Integration

Handles credit checks and deductions for Kortix tools.
"""

from decimal import Decimal
from typing import Dict, Optional, Tuple
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.billing.credits.manager import credit_manager
from core.billing.shared.cache_utils import invalidate_account_state_cache
from .config import get_tool_cost


class KortixBillingIntegration:
    """
    Handles billing for Kortix tool operations.
    """

    @staticmethod
    def is_development_mode() -> bool:
        """Check if running in development/local mode (skip billing)."""
        return config.ENV_MODE == EnvMode.LOCAL

    @staticmethod
    async def check_credits(
        account_id: str,
        minimum_required: Decimal = Decimal("0.01")
    ) -> Tuple[bool, str, Optional[Decimal]]:
        """
        Check if user has sufficient credits for tool usage.

        Args:
            account_id: User's account ID
            minimum_required: Minimum credits required (in USD)

        Returns:
            Tuple of (has_credits, message, current_balance)
        """
        # Skip billing for test token (00000 → test_account)
        if account_id == "test_account":
            logger.debug("[KORTIX_BILLING] Test account - skipping credit check")
            return True, "Test mode", Decimal("999999")

        if KortixBillingIntegration.is_development_mode():
            logger.debug("[KORTIX_BILLING] Development mode - skipping credit check")
            return True, "Development mode", Decimal("999999")

        try:
            balance_info = await credit_manager.get_balance(account_id, use_cache=True)

            if isinstance(balance_info, dict):
                balance = Decimal(str(balance_info.get("total", 0)))
            else:
                balance = Decimal(str(balance_info or 0))

            if balance < minimum_required:
                logger.warning(
                    f"[KORTIX_BILLING] Insufficient credits for {account_id}: "
                    f"${balance:.4f} < ${minimum_required:.4f}"
                )
                return (
                    False,
                    f"Insufficient credits. Your balance is ${balance:.2f}. Please add credits to continue.",
                    balance,
                )

            logger.debug(f"[KORTIX_BILLING] Credit check passed for {account_id}: ${balance:.4f}")
            return True, f"Credits available: ${balance:.2f}", balance

        except Exception as e:
            logger.error(f"[KORTIX_BILLING] Error checking credits for {account_id}: {e}")
            # Fail open in case of error - let the operation proceed
            return True, f"Credit check error: {str(e)}", None

    @staticmethod
    async def deduct_tool_credits(
        account_id: str,
        tool_name: str,
        result_count: int = 0,
        description: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict:
        """
        Deduct credits for a Kortix tool call.

        Args:
            account_id: User's account ID
            tool_name: Name of the tool (e.g., "web_search_basic", "image_search")
            result_count: Number of results returned
            description: Custom description for the transaction
            session_id: Optional session ID for tracking

        Returns:
            Dict with success status and details
        """
        # Skip billing for test token (00000 → test_account)
        if account_id == "test_account":
            logger.debug("[KORTIX_BILLING] Test account - skipping credit deduction")
            return {
                "success": True,
                "cost": 0,
                "new_balance": 999999,
                "skipped": True,
                "reason": "test_token",
            }

        if KortixBillingIntegration.is_development_mode():
            logger.debug("[KORTIX_BILLING] Development mode - skipping credit deduction")
            return {
                "success": True,
                "cost": 0,
                "new_balance": 999999,
                "skipped": True,
                "reason": "development_mode",
            }

        try:
            cost = get_tool_cost(tool_name, result_count)

            if cost <= 0:
                logger.warning(f"[KORTIX_BILLING] Zero cost calculated for {tool_name}")
                return {"success": True, "cost": 0, "new_balance": 0}

            if not description:
                description = f"Kortix {tool_name.replace('_', ' ').title()}"

            logger.info(
                f"[KORTIX_BILLING] Deducting ${cost:.4f} for {tool_name} from {account_id}"
            )

            result = await credit_manager.deduct_credits(
                account_id=account_id,
                amount=cost,
                description=description,
                type="kortix_tool",
            )

            if result.get("success"):
                new_balance = result.get("new_total", result.get("new_balance", 0))
                logger.info(
                    f"[KORTIX_BILLING] Successfully deducted ${cost:.4f} from {account_id}. "
                    f"New balance: ${new_balance:.2f}"
                )
                await invalidate_account_state_cache(account_id)
            else:
                logger.error(
                    f"[KORTIX_BILLING] Failed to deduct credits for {account_id}: "
                    f"{result.get('error')}"
                )

            return {
                "success": result.get("success", False),
                "cost": float(cost),
                "new_balance": result.get("new_total", result.get("new_balance", 0)),
                "from_expiring": result.get("from_expiring", 0),
                "from_non_expiring": result.get("from_non_expiring", 0),
                "transaction_id": result.get("transaction_id", result.get("ledger_id")),
            }

        except Exception as e:
            logger.error(f"[KORTIX_BILLING] Error deducting credits for {account_id}: {e}")
            return {"success": False, "error": str(e), "cost": 0}


# Singleton instance
kortix_billing = KortixBillingIntegration()
