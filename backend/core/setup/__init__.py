"""
Account Setup Module

Handles account initialization for new users:
- Free tier subscription setup
- Default Suna agent installation
- Welcome email sending

All initialization happens automatically via database webhook on user signup.
"""

from .api import router, webhook_router, initialize_user_account

__all__ = ['router', 'webhook_router', 'initialize_user_account']

