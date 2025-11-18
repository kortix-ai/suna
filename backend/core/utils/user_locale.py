"""
Utility functions for retrieving user locale preferences from Supabase Auth.
"""

from typing import Optional
from core.utils.logger import logger
from core.services.supabase import DBConnection

# Supported locales (must match frontend)
SUPPORTED_LOCALES = ['en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es']
DEFAULT_LOCALE = 'en'


async def get_user_locale(user_id: str, client=None) -> str:
    """
    Get user's preferred locale from auth.users.raw_user_meta_data.
    
    Uses the get_user_metadata RPC function which queries auth.users.
    If PostgREST schema cache hasn't refreshed yet, this will fail gracefully
    and default to English.
    
    Args:
        user_id: The user ID (UUID string)
        client: Optional Supabase client. If not provided, creates a new connection.
    
    Returns:
        Locale string ('en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es') or 'en' as default
    """
    try:
        if client is None:
            db = DBConnection()
            await db.initialize()
            client = await db.client
        
        # Use RPC function to get user metadata
        # Note: This requires PostgREST schema cache to be refreshed after migration
        result = await client.rpc('get_user_metadata', {'user_id': user_id}).execute()
        
        # Log the full result object for debugging
        logger.debug(f"🔍 RPC result for user {user_id}: {result}")
        logger.debug(f"🔍 RPC result.data type: {type(result.data)}, value: {result.data}")
        
        # Handle the response - result.data should be a dict (JSONB from PostgreSQL)
        # But handle edge cases where it might be a list or other type
        if result.data:
            if isinstance(result.data, dict):
                metadata = result.data
            elif isinstance(result.data, list) and len(result.data) > 0:
                # If it's a list, take the first element (shouldn't happen for this function, but be safe)
                metadata = result.data[0] if isinstance(result.data[0], dict) else {}
            else:
                # Fallback: try to convert to dict or use empty dict
                metadata = {}
                logger.warning(f"⚠️ Unexpected result.data type for user {user_id}: {type(result.data)}")
            
            logger.debug(f"🔍 Parsed metadata object: {metadata}")
            logger.debug(f"🔍 Metadata keys: {list(metadata.keys()) if isinstance(metadata, dict) else 'N/A'}")
            
            # Extract locale from metadata
            locale = metadata.get('locale') if isinstance(metadata, dict) else None
            logger.debug(f"🔍 Extracted locale value: {locale}")
            
            if locale and locale in SUPPORTED_LOCALES:
                logger.debug(f"✅ Found user locale preference: {locale} for user {user_id}")
                return locale
            elif locale:
                logger.warning(f"⚠️ Invalid locale '{locale}' for user {user_id}, not in supported locales: {SUPPORTED_LOCALES}")
        
        logger.debug(f"⚠️ No locale preference found for user {user_id}, using default: {DEFAULT_LOCALE}")
        return DEFAULT_LOCALE
        
    except Exception as e:
        # RPC function might not be available yet if PostgREST schema cache hasn't refreshed
        # This is expected immediately after running the migration
        error_msg = str(e)
        if 'PGRST202' in error_msg or 'Could not find the function' in error_msg:
            logger.debug(f"RPC function not yet available in PostgREST cache for user {user_id}. This is normal immediately after migration. PostgREST will auto-refresh its cache shortly.")
        else:
            logger.warning(f"Error fetching user locale for user {user_id}: {e}")
        return DEFAULT_LOCALE


def get_locale_context_prompt(locale: str) -> str:
    """
    Generate a locale-specific context prompt to add to the system prompt.
    
    Args:
        locale: User's preferred locale ('en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es')
    
    Returns:
        Formatted prompt string with locale instructions
    """
    locale_instructions = {
        'en': """## LANGUAGE PREFERENCE
The user has set their preferred language to English. You should respond in English and use English terminology throughout your responses.""",
        'de': """## SPRACHPREFERENZ
Der Benutzer hat Deutsch als bevorzugte Sprache eingestellt. Sie sollten auf Deutsch antworten und durchgehend deutsche Terminologie verwenden. Alle Ihre Antworten, Erklärungen und Interaktionen sollten in deutscher Sprache erfolgen.""",
        'it': """## PREFERENZA LINGUISTICA
L'utente ha impostato l'italiano come lingua preferita. Dovresti rispondere in italiano e utilizzare terminologia italiana in tutte le tue risposte. Tutte le tue risposte, spiegazioni e interazioni dovrebbero essere in italiano.""",
        'zh': """## 语言偏好
用户已将首选语言设置为中文。您应该用中文回复，并在所有回复中使用中文术语。您的所有回复、解释和交互都应该是中文。""",
        'ja': """## 言語設定
ユーザーは日本語を優先言語に設定しています。日本語で応答し、すべての応答で日本語の用語を使用してください。すべての応答、説明、インタラクションは日本語で行う必要があります。""",
        'pt': """## PREFERÊNCIA DE IDIOMA
O usuário definiu o português como idioma preferido. Você deve responder em português e usar terminologia portuguesa em todas as suas respostas. Todas as suas respostas, explicações e interações devem ser em português.""",
        'fr': """## PRÉFÉRENCE DE LANGUE
L'utilisateur a défini le français comme langue préférée. Vous devez répondre en français et utiliser la terminologie française dans toutes vos réponses. Toutes vos réponses, explications et interactions doivent être en français.""",
        'es': """## PREFERENCIA DE IDIOMA
El usuario ha establecido el español como idioma preferido. Debes responder en español y usar terminología española en todas tus respuestas. Todas tus respuestas, explicaciones e interacciones deben ser en español."""
    }
    
    return locale_instructions.get(locale, locale_instructions['en'])

