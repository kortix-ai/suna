"""
Core module for the agentpress backend.

Domain logic for agents, threads, and related functionality.
All routers are aggregated in api.py.

Database access patterns:

For Convex (primary database):
    from core.services.convex_client import get_convex_client
    convex = get_convex_client()
    thread = await convex.create_thread(...)
    messages = await convex.get_messages(thread_id=...)

FastAPI dependencies:
    from core.utils.db_helpers import get_convex
    convex = Depends(get_convex)  # For Convex operations
"""
