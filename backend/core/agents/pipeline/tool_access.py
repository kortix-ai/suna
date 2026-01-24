from typing import Optional
from dataclasses import dataclass
from core.utils.logger import logger


@dataclass
class ToolAccessResult:
    allowed: bool
    reason: Optional[str] = None
    error_code: Optional[str] = None
    upgrade_required: bool = False
    current_tier: Optional[str] = None
    current_tier_display: Optional[str] = None

def check_tool_access(tier_name: str, tool_name: str) -> ToolAccessResult:
    from core.billing.shared.config import is_tool_disabled, get_tier_by_name
    if is_tool_disabled(tier_name, tool_name):
        tier = get_tier_by_name(tier_name)
        display_name = tier.display_name if tier else tier_name
        return ToolAccessResult(
            allowed=False,
            reason=(
                f"FEATURE_UNAVAILABLE: The '{tool_name}' tool is not available on the {display_name} plan. "
                f"This is a subscription limitation, NOT an error - do not retry this tool. "
                f"Inform the user that this feature requires upgrading their plan."
            ),
            error_code="TOOL_ACCESS_DENIED",
            upgrade_required=True,
            current_tier=tier_name,
            current_tier_display=display_name,
        )

    return ToolAccessResult(allowed=True)


def is_tool_allowed(tier_name: str, tool_name: str) -> bool:
    from core.billing.shared.config import is_tool_disabled
    return not is_tool_disabled(tier_name, tool_name)


async def check_tool_access_for_account(account_id: str, tool_name: str) -> ToolAccessResult:
    try:
        from core.cache.runtime_cache import get_cached_tier_info
        tier_info = await get_cached_tier_info(account_id)
        if not tier_info:
            return ToolAccessResult(allowed=True)

        tier_name = tier_info.get('name', 'free')
        return check_tool_access(tier_name, tool_name)
    except Exception as e:
        logger.warning(f"Failed to check tool access for {account_id}: {e}")
        return ToolAccessResult(allowed=True)
