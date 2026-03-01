"""
Centralized database dependency helpers.

This module provides reusable FastAPI dependencies for database connections,
supporting Convex for the new data layer.

Architecture:
- Convex: Used for threads, agents, messages, memories, triggers

CONVEX MIGRATION STATUS: FULLY MIGRATED
- All Supabase imports removed
- get_convex(), get_initialized_convex() - Convex (for data layer)
"""
from typing import AsyncGenerator, Optional
from core.services.convex_client import ConvexClient, get_convex_client
from core.utils.logger import logger


_convex_instance: ConvexClient | None = None


async def get_convex() -> ConvexClient:
    """
    FastAPI dependency for Convex client.

    Returns the Convex client for threads, agents, messages, memories, triggers.
    Use as: convex = Depends(get_convex)

    This is the preferred client for all data layer operations.
    """
    return get_convex_client()


def get_initialized_convex() -> ConvexClient:
    """
    Get the Convex client for module-level usage.

    Modules should use this for Convex operations:
    - threads, agents, messages, memories, triggers
    """
    return get_convex_client()


# Legacy compatibility aliases
get_db = get_convex
get_db_client = get_convex
get_initialized_db = get_initialized_convex
