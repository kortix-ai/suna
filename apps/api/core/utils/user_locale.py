"""
Utility functions for retrieving user locale preferences.

CONVEX MIGRATION STATUS: MIGRATED - USING CONVEX FOR USER PREFERENCES
=====================================================================
This module now uses Convex for user preferences storage instead of
Supabase auth.users metadata.

The user preferences (including locale) are stored in a Convex table.
If no preference is found, returns the default locale.

Migration from Supabase:
- Previously: Used auth.users.raw_user_meta_data via RPC
- Now: Uses Convex userPreferences table

TODO: Add userPreferences table to Convex schema if not already present:
- user_id (string)
- locale (string)
- other preferences as needed
"""
from typing import Optional
from core.utils.logger import logger
from core.services.convex_client import get_convex_client, ConvexError

# Supported locales (must match frontend)
SUPPORTED_LOCALES = ['en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es']
DEFAULT_LOCALE = 'en'


async def get_user_locale(user_id: str, client=None) -> str:
    """
    Get user's preferred locale from Convex userPreferences.

    Args:
        user_id: The user ID
        client: Optional Convex client (uses singleton if not provided)

    Returns:
        Locale string ('en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es') or 'en' as default
    """
    try:
        convex = client or get_convex_client()

        # Try to get user preferences from Convex
        # Note: This requires a userPreferences table in Convex
        try:
            # Use the Convex client to query user preferences
            # The actual method depends on your Convex schema
            preferences = await convex._request(
                "/api/user-preferences/get",
                "GET",
                params={"userId": user_id}
            )

            if preferences:
                locale = preferences.get('locale')
                logger.debug(f"Found locale preference: {locale} for user {user_id}")

                if locale and locale in SUPPORTED_LOCALES:
                    return locale
                elif locale:
                    logger.warning(
                        f"Invalid locale '{locale}' for user {user_id}, "
                        f"not in supported locales: {SUPPORTED_LOCALES}"
                    )

        except ConvexError as e:
            # Table might not exist yet, log and fall back to default
            if "NOT_FOUND" in str(e) or "not found" in str(e).lower():
                logger.debug(f"No user preferences found for user {user_id}, using default locale")
            else:
                logger.warning(f"Error fetching user preferences from Convex: {e}")

    except Exception as e:
        logger.warning(f"Error fetching user locale for user {user_id}: {e}")

    logger.debug(f"No locale preference found for user {user_id}, using default: {DEFAULT_LOCALE}")
    return DEFAULT_LOCALE


def get_locale_context_prompt(locale: str) -> str:
    """
    Generate a locale-specific context prompt to add to the system prompt.

    Args:
        locale: User's preferred locale ('en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es')

    Returns:
        Formatted prompt string with locale instructions
    """
    # Simple instruction: respond in whatever language the user writes in
    return """## LANGUAGE
Respond in the language the user is writing in. Match their language naturally."""


async def set_user_locale(user_id: str, locale: str, client=None) -> bool:
    """
    Set user's preferred locale in Convex userPreferences.

    Args:
        user_id: The user ID
        locale: The locale to set
        client: Optional Convex client

    Returns:
        True if successful, False otherwise
    """
    if locale not in SUPPORTED_LOCALES:
        logger.warning(f"Invalid locale '{locale}', not in supported locales: {SUPPORTED_LOCALES}")
        return False

    try:
        convex = client or get_convex_client()

        await convex._request(
            "/api/user-preferences/set",
            "POST",
            data={"userId": user_id, "locale": locale}
        )

        logger.debug(f"Set locale preference to {locale} for user {user_id}")
        return True

    except Exception as e:
        logger.error(f"Error setting user locale for user {user_id}: {e}")
        return False
