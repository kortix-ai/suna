"""
Core module for the agentpress backend.

Domain logic for agents, threads, and related functionality.
All routers are aggregated in api.py.

Database access: Use DBConnection singleton directly:
    from core.services.supabase import DBConnection
    db = DBConnection()
    client = await db.client
"""
