"""
Kortix Tools Router

Provides API endpoints for Kortix OpenCode plugin tools:
- Web Search (via Tavily)
- Image Search (via Serper/Google)

All endpoints handle billing automatically based on user's account.
"""

from .api import router

__all__ = ["router"]
