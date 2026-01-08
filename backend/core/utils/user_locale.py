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
            # Use singleton - already initialized at startup
            db = DBConnection()
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
The user has set their preferred UI language to English. Default to responding in English using an informal, semi-personal, and neutral tone. Use casual but professional language throughout your responses.

IMPORTANT: If the user is typing in a different language in the chat, respond in the language the user is currently using (infer from the most recent user message). Treat the locale as a UI/tone preference and use it only as a fallback when the user's message language is unclear.""",
        'de': """## SPRACHPREFERENZ
Der Benutzer hat Deutsch als bevorzugte UI-Sprache eingestellt. Standardmäßig sollst du auf Deutsch antworten und dabei eine informelle, halbpersönliche und neutrale Tonart verwenden. Verwende "du" statt "Sie" und eine lockere aber professionelle Sprache in allen deinen Antworten, Erklärungen und Interaktionen.

WICHTIG: Wenn der Benutzer im Chat in einer anderen Sprache schreibt, antworte in der Sprache, die der Benutzer aktuell verwendet (ableiten aus der letzten Benutzernachricht). Betrachte die Locale nur als UI-/Ton-Voreinstellung und nutze sie nur als Fallback, wenn die Sprache der Benutzernachricht unklar ist.""",
        'it': """## PREFERENZA LINGUISTICA
L'utente ha impostato l'italiano come lingua preferita dell'interfaccia. Di default rispondi in italiano usando un tono informale, semi-personale e neutro. Usa "tu" invece di "Lei" e un linguaggio casuale ma professionale in tutte le tue risposte, spiegazioni e interazioni.

IMPORTANTE: Se l'utente sta scrivendo in un'altra lingua nella chat, rispondi nella lingua che l'utente sta usando in quel momento (inferiscila dall'ultimo messaggio dell'utente). Considera la locale come una preferenza di UI/tono e usala solo come fallback quando la lingua del messaggio non è chiara.""",
        'zh': """## 语言偏好
用户已将界面首选语言设置为中文。默认用中文回复，使用非正式、半个人化且中性的语气。在所有回复、解释和交互中使用随意但专业的语言。

重要：如果用户在聊天中使用另一种语言输入，请用用户当前使用的语言回复（根据用户的最新一条消息判断）。将 locale 视为界面/语气偏好；只有在用户消息语言不明确时才作为后备。""",
        'ja': """## 言語設定
ユーザーは日本語を優先言語（UI）に設定しています。デフォルトでは日本語で応答し、カジュアルで半個人的かつ中立的なトーンを使用してください。すべての応答、説明、インタラクションでカジュアルだがプロフェッショナルな言語を使用してください。

重要：ユーザーがチャットで別の言語で入力している場合は、ユーザーが現在使っている言語で返答してください（直近のユーザーメッセージから推定）。locale はUI/トーンの設定として扱い、ユーザーメッセージの言語が不明確な場合のみフォールバックとして使用してください。""",
        'pt': """## PREFERÊNCIA DE IDIOMA
O usuário definiu o português como idioma preferido da interface. Por padrão, responda em português usando um tom informal, semi-pessoal e neutro. Use linguagem casual mas profissional em todas as suas respostas, explicações e interações.

IMPORTANTE: Se o usuário estiver digitando em outro idioma no chat, responda no idioma que o usuário está usando no momento (inferido da mensagem mais recente do usuário). Trate a locale apenas como preferência de UI/tom e use-a apenas como fallback quando o idioma da mensagem do usuário não estiver claro.""",
        'fr': """## PRÉFÉRENCE DE LANGUE
L'utilisateur a défini le français comme langue préférée de l'interface. Par défaut, réponds en français en utilisant un ton informel, semi-personnel et neutre. Utilise "tu" au lieu de "vous" et un langage décontracté mais professionnel dans toutes tes réponses, explications et interactions.

IMPORTANT : si l'utilisateur écrit dans une autre langue dans le chat, réponds dans la langue qu'il utilise actuellement (déduite du dernier message utilisateur). Considère la locale comme une préférence d'UI/de ton et ne l'utilise qu'en recours si la langue du message n'est pas claire.""",
        'es': """## PREFERENCIA DE IDIOMA
El usuario ha establecido el español como idioma preferido de la interfaz. Por defecto, responde en español usando un tono informal, semi-personal y neutro. Usa "tú" en lugar de "usted" y un lenguaje casual pero profesional en todas tus respuestas, explicaciones e interacciones.

IMPORTANTE: Si el usuario está escribiendo en otro idioma en el chat, responde en el idioma que el usuario esté usando en ese momento (inferido del mensaje más reciente del usuario). Considera la locale solo como una preferencia de UI/tono y úsala únicamente como fallback cuando el idioma del mensaje no esté claro."""
    }
    
    return locale_instructions.get(locale, locale_instructions['en'])

