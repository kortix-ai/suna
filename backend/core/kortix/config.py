"""
Kortix Tools Configuration

Pricing and configuration for Kortix tools.
"""

from decimal import Decimal
from dataclasses import dataclass
from typing import Dict
import os


@dataclass
class ToolPricing:
    """Pricing configuration for a tool."""
    base_cost: Decimal  # Base cost per call
    per_result_cost: Decimal  # Additional cost per result
    markup_multiplier: Decimal  # Markup on top of base cost


# Pricing for Kortix tools (in USD)
# Tavily: $5/1000 searches for basic, $25/1000 for advanced
# We add markup for sustainability
TOOL_PRICING: Dict[str, ToolPricing] = {
    "web_search_basic": ToolPricing(
        base_cost=Decimal("0.005"),  # $5/1000 = $0.005
        per_result_cost=Decimal("0"),
        markup_multiplier=Decimal("1.5"),  # 50% markup
    ),
    "web_search_advanced": ToolPricing(
        base_cost=Decimal("0.025"),  # $25/1000 = $0.025
        per_result_cost=Decimal("0"),
        markup_multiplier=Decimal("1.5"),
    ),
    "image_search": ToolPricing(
        base_cost=Decimal("0.001"),  # Very cheap via Serper
        per_result_cost=Decimal("0"),
        markup_multiplier=Decimal("2.0"),  # 100% markup
    ),
}


def get_tool_cost(tool_name: str, result_count: int = 0) -> Decimal:
    """
    Calculate the cost for a tool call.

    Args:
        tool_name: Name of the tool (e.g., "web_search_basic")
        result_count: Number of results returned

    Returns:
        Cost in USD with markup applied
    """
    pricing = TOOL_PRICING.get(tool_name)
    if not pricing:
        return Decimal("0.01")  # Default fallback cost

    base = pricing.base_cost * pricing.markup_multiplier
    per_result = pricing.per_result_cost * pricing.markup_multiplier * Decimal(result_count)
    return base + per_result


# API Keys
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
SERPER_API_KEY = os.getenv("SERPER_API_KEY", "")
