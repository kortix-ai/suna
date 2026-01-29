"""
Conversation Analyzer

Analyzes agent conversations using LLM to extract:
- Sentiment and frustration levels
- Churn risk indicators
- Topic classification
- Feature request detection
"""

import json
from typing import Optional, Dict, Any, List
from datetime import datetime, timedelta

from core.services.supabase import DBConnection
from core.services.llm import make_llm_api_call
from core.memory.embedding_service import EmbeddingService
from core.utils.logger import logger

# Default seed categories (used when DB is empty)
DEFAULT_USE_CASE_CATEGORIES = [
    "create_presentation",
    "create_document",
    "create_spreadsheet",
    "create_image",
    "scrape_data",
    "write_code",
    "debug_code",
]


async def get_existing_categories() -> List[str]:
    """
    Fetch all unique use_case_category values from the database.
    This allows the category list to grow organically as new use cases are discovered.
    """
    try:
        db = DBConnection()
        client = await db.client

        result = await client.from_('conversation_analytics')\
            .select('use_case_category')\
            .not_.is_('use_case_category', 'null')\
            .execute()

        # Get unique categories
        categories = set()
        for r in result.data or []:
            cat = r.get('use_case_category')
            if cat:
                categories.add(cat)

        # If no categories in DB yet, use defaults
        if not categories:
            return DEFAULT_USE_CASE_CATEGORIES

        return sorted(list(categories))

    except Exception as e:
        logger.warning(f"[ANALYTICS] Failed to fetch existing categories: {e}")
        return DEFAULT_USE_CASE_CATEGORIES

def build_analysis_prompt(existing_categories: List[str]) -> str:
    """Build the analysis prompt with dynamic categories from DB."""
    categories_str = ", ".join(existing_categories) if existing_categories else "none yet"

    return f"""Analyze this AI agent conversation between a user and an AI assistant. Return valid JSON only.

IMPORTANT: Be objective and evidence-based. Only flag frustration if there are clear signals.

Return this exact JSON structure:
{{
  "sentiment": "<one of: positive, neutral, negative, mixed>",
  "frustration": {{
    "score": <float from 0 (none) to 1 (severe)>,
    "signals": ["<list of specific frustration indicators found, empty if none>"]
  }},
  "intent_type": "<one of: question, task, complaint, feature_request, chat>",
  "feature_request": {{
    "detected": <boolean>,
    "text": "<description of requested feature if detected, null otherwise>"
  }},
  "use_case": {{
    "is_useful": <true if user accomplished a real task, false if just chat/greeting/gibberish/question>,
    "category": "<EXISTING CATEGORIES: {categories_str}. If no fit, CREATE NEW using format: action_subject>",
    "summary": "<2-4 word task description, or null if not useful>",
    "output_type": "<presentation, document, spreadsheet, code, report, data, email, website, image, audio, video, other, none>",
    "domain": "<sales, marketing, finance, hr, engineering, research, personal, support, other>"
  }},
  "keywords": ["<3-5 key terms from conversation>"]
}}

FRUSTRATION SIGNALS:
- Repeated requests for the same thing
- Expressions like "still not working", "this is frustrating", "I give up"
- Multiple error corrections
- Negative language about the assistant's performance

Analyze the following conversation:
"""


async def queue_for_analysis(
    thread_id: str,
    agent_run_id: Optional[str],
    account_id: str
) -> None:
    """
    Add a conversation to the analysis queue.

    This is a non-blocking operation that inserts into the queue table.
    The background worker will process it asynchronously.

    Args:
        thread_id: The thread ID to analyze
        agent_run_id: Optional agent run ID
        account_id: The account that owns the thread
    """
    try:
        db = DBConnection()
        client = await db.client

        # Check if already queued or analyzed recently
        existing = await client.from_('conversation_analytics_queue')\
            .select('id')\
            .eq('thread_id', thread_id)\
            .in_('status', ['pending', 'processing'])\
            .execute()

        if existing.data:
            logger.debug(f"[ANALYTICS] Thread {thread_id} already in queue, skipping")
            return

        # Insert into queue
        await client.from_('conversation_analytics_queue').insert({
            'thread_id': thread_id,
            'agent_run_id': agent_run_id,
            'account_id': account_id,
            'status': 'pending',
            'attempts': 0,
        }).execute()

        logger.debug(f"[ANALYTICS] Queued thread {thread_id} for analysis")

    except Exception as e:
        # Non-critical - don't fail the main flow
        logger.warning(f"[ANALYTICS] Failed to queue thread {thread_id}: {e}")


async def fetch_conversation_messages(
    thread_id: str,
    agent_run_id: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Fetch messages from a thread for analysis.

    If agent_run_id is provided, only fetches messages from that run's time range.
    Returns only actual conversation messages (user, assistant, tool).
    """
    db = DBConnection()
    client = await db.client

    # If agent_run_id provided, get time range
    started_at = None
    completed_at = None
    if agent_run_id:
        run_result = await client.from_('agent_runs')\
            .select('started_at, completed_at')\
            .eq('id', agent_run_id)\
            .single()\
            .execute()
        if run_result.data:
            # Include 30 seconds before started_at to capture triggering user message
            raw_started = run_result.data.get('started_at')
            if raw_started:
                started_dt = datetime.fromisoformat(raw_started.replace('Z', '+00:00'))
                started_at = (started_dt - timedelta(seconds=30)).isoformat()
            completed_at = run_result.data.get('completed_at')

    query = client.from_('messages')\
        .select('type, content, created_at')\
        .eq('thread_id', thread_id)\
        .eq('is_llm_message', True)\
        .in_('type', ['user', 'assistant', 'tool'])

    # Filter by time range if available
    if started_at:
        query = query.gte('created_at', started_at)
    if completed_at:
        query = query.lte('created_at', completed_at)

    result = await query.order('created_at', desc=False).execute()

    return result.data or []


def format_conversation_for_analysis(messages: List[Dict[str, Any]]) -> str:
    """
    Format messages into a readable conversation string for the LLM.
    """
    lines = []
    for msg in messages:
        role = msg.get('type', 'unknown').upper()
        content = msg.get('content', '')

        # Handle content that might be a list (tool calls, etc.)
        if isinstance(content, list):
            # Extract text content from content blocks
            text_parts = []
            for block in content:
                if isinstance(block, dict):
                    if block.get('type') == 'text':
                        text_parts.append(block.get('text', ''))
                    elif block.get('type') == 'tool_use':
                        text_parts.append(f"[Tool: {block.get('name', 'unknown')}]")
                elif isinstance(block, str):
                    text_parts.append(block)
            content = ' '.join(text_parts)

        # Truncate very long messages
        if len(content) > 2000:
            content = content[:2000] + "... [truncated]"

        lines.append(f"{role}: {content}")

    return "\n\n".join(lines)


async def analyze_conversation(
    thread_id: str,
    agent_run_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """
    Analyze a conversation using LLM.

    Args:
        thread_id: The thread ID to analyze
        agent_run_id: Optional agent run ID to filter messages by time range

    Returns:
        Analysis results dict or None if analysis fails
    """
    try:
        # Fetch messages (filtered by agent run time range if provided)
        messages = await fetch_conversation_messages(thread_id, agent_run_id)

        if not messages:
            logger.debug(f"[ANALYTICS] No messages found for thread {thread_id}")
            return None

        # Count messages by type
        user_count = sum(1 for m in messages if m.get('type') == 'user')
        assistant_count = sum(1 for m in messages if m.get('type') == 'assistant')

        # Skip very short conversations (likely not meaningful)
        if user_count < 1:
            logger.debug(f"[ANALYTICS] Thread {thread_id} has no user messages, skipping")
            return None

        # Calculate duration
        if len(messages) >= 2:
            first_time = messages[0].get('created_at')
            last_time = messages[-1].get('created_at')
            if first_time and last_time:
                try:
                    first_dt = datetime.fromisoformat(first_time.replace('Z', '+00:00'))
                    last_dt = datetime.fromisoformat(last_time.replace('Z', '+00:00'))
                    duration_seconds = int((last_dt - first_dt).total_seconds())
                except Exception:
                    duration_seconds = None
            else:
                duration_seconds = None
        else:
            duration_seconds = None

        # Format for LLM
        conversation_text = format_conversation_for_analysis(messages)

        # Limit total context size
        if len(conversation_text) > 15000:
            conversation_text = conversation_text[:15000] + "\n\n[... conversation truncated for analysis ...]"

        # Fetch existing categories from DB (list grows organically)
        existing_categories = await get_existing_categories()
        analysis_prompt = build_analysis_prompt(existing_categories)
        logger.debug(f"[ANALYTICS] Using {len(existing_categories)} existing categories")

        # Call LLM for analysis
        response = await make_llm_api_call(
            messages=[
                {"role": "system", "content": analysis_prompt},
                {"role": "user", "content": conversation_text}
            ],
            model_name="openai/gpt-5-nano-2025-08-07",
            temperature=0.3,
            stream=False,
            response_format={"type": "json_object"},
        )

        # Parse response
        if not response or not hasattr(response, 'choices'):
            logger.warning(f"[ANALYTICS] No response from LLM for thread {thread_id}")
            return None

        content = response.choices[0].message.content

        # Parse JSON from response
        try:
            # Try to extract JSON from the response
            analysis = json.loads(content)
        except json.JSONDecodeError:
            # Try to find JSON in the response
            import re
            json_match = re.search(r'\{[\s\S]*\}', content)
            if json_match:
                try:
                    analysis = json.loads(json_match.group())
                except json.JSONDecodeError:
                    logger.warning(f"[ANALYTICS] Failed to parse LLM response for thread {thread_id}")
                    return None
            else:
                logger.warning(f"[ANALYTICS] No JSON found in LLM response for thread {thread_id}")
                return None

        # Build result
        use_case = analysis.get('use_case', {})
        use_case_category = use_case.get('category')
        use_case_summary = use_case.get('summary')

        # Generate embedding for the use case CATEGORY (for clustering)
        # Category is more consistent than summary, leading to better clusters
        use_case_embedding = None
        text_to_embed = use_case_category or use_case_summary
        if text_to_embed:
            try:
                embedding_service = EmbeddingService()
                use_case_embedding = await embedding_service.embed_text(text_to_embed)
                logger.debug(f"[ANALYTICS] Generated embedding for use case: {text_to_embed}")
            except Exception as e:
                logger.warning(f"[ANALYTICS] Failed to embed use case for thread {thread_id}: {e}")

        result = {
            'sentiment_label': analysis.get('sentiment'),
            'frustration_score': analysis.get('frustration', {}).get('score'),
            'frustration_signals': analysis.get('frustration', {}).get('signals', []),
            'intent_type': analysis.get('intent_type'),
            'is_feature_request': analysis.get('feature_request', {}).get('detected', False),
            'feature_request_text': analysis.get('feature_request', {}).get('text'),
            'is_useful': use_case.get('is_useful', True),  # Whether user accomplished a real task
            'use_case_category': use_case_category,
            'use_case_summary': use_case_summary,
            'output_type': use_case.get('output_type'),
            'domain': use_case.get('domain'),
            'keywords': analysis.get('keywords', []),
            'user_message_count': user_count,
            'assistant_message_count': assistant_count,
            'conversation_duration_seconds': duration_seconds,
            'use_case_embedding': use_case_embedding,
            'raw_analysis': analysis,
        }

        logger.debug(f"[ANALYTICS] Analyzed thread {thread_id}: category={use_case_category}, summary={use_case_summary}")
        return result

    except Exception as e:
        logger.error(f"[ANALYTICS] Error analyzing thread {thread_id}: {e}")
        return None


async def store_analysis(
    thread_id: str,
    agent_run_id: Optional[str],
    account_id: str,
    analysis: Dict[str, Any],
    agent_run_status: Optional[str] = None
) -> bool:
    """
    Store analysis results in the database.

    Args:
        thread_id: Thread ID
        agent_run_id: Optional agent run ID
        account_id: Account ID
        analysis: Analysis results from analyze_conversation
        agent_run_status: Optional status of the agent run

    Returns:
        True if stored successfully
    """
    try:
        db = DBConnection()
        client = await db.client

        # Format embedding for pgvector storage
        embedding = analysis.get('use_case_embedding')
        embedding_str = None
        if embedding:
            embedding_str = f"[{','.join(str(x) for x in embedding)}]"

        record = {
            'thread_id': thread_id,
            'agent_run_id': agent_run_id,
            'account_id': account_id,
            'sentiment_label': analysis.get('sentiment_label'),
            'frustration_score': analysis.get('frustration_score'),
            'frustration_signals': json.dumps(analysis.get('frustration_signals', [])),
            'intent_type': analysis.get('intent_type'),
            'is_feature_request': analysis.get('is_feature_request', False),
            'feature_request_text': analysis.get('feature_request_text'),
            'is_useful': analysis.get('is_useful', True),
            'use_case_category': analysis.get('use_case_category'),
            'use_case_summary': analysis.get('use_case_summary'),
            'output_type': analysis.get('output_type'),
            'domain': analysis.get('domain'),
            'keywords': json.dumps(analysis.get('keywords', [])),
            'user_message_count': analysis.get('user_message_count'),
            'assistant_message_count': analysis.get('assistant_message_count'),
            'conversation_duration_seconds': analysis.get('conversation_duration_seconds'),
            'agent_run_status': agent_run_status,
            'raw_analysis': json.dumps(analysis.get('raw_analysis', {})),
            'use_case_embedding': embedding_str,
        }

        await client.from_('conversation_analytics').insert(record).execute()

        logger.debug(f"[ANALYTICS] Stored analysis for thread {thread_id}")
        return True

    except Exception as e:
        logger.error(f"[ANALYTICS] Failed to store analysis for thread {thread_id}: {e}")
        return False


async def calculate_churn_risk(account_id: str, days: int = 30) -> Dict[str, Any]:
    """
    Calculate churn risk from historical frustration data.

    Logic:
    - Get frustration scores from last N days
    - Higher average frustration = higher churn risk
    - Increasing frustration trend = higher churn risk

    Returns:
        {
            'churn_risk_score': float 0-1,
            'frustration_count': int,
            'avg_frustration': float,
            'trend': 'increasing' | 'stable' | 'decreasing'
        }
    """
    try:
        db = DBConnection()
        client = await db.client

        # Get frustration scores from last N days
        from_date = (datetime.utcnow() - timedelta(days=days)).isoformat()

        result = await client.from_('conversation_analytics')\
            .select('frustration_score, created_at')\
            .eq('account_id', account_id)\
            .gte('created_at', from_date)\
            .not_.is_('frustration_score', 'null')\
            .order('created_at', desc=False)\
            .execute()

        if not result.data or len(result.data) < 2:
            return {
                'churn_risk_score': 0,
                'frustration_count': len(result.data) if result.data else 0,
                'avg_frustration': 0,
                'trend': 'stable'
            }

        scores = [r['frustration_score'] for r in result.data if r['frustration_score'] is not None]

        if not scores:
            return {
                'churn_risk_score': 0,
                'frustration_count': 0,
                'avg_frustration': 0,
                'trend': 'stable'
            }

        avg_frustration = sum(scores) / len(scores)

        # Calculate trend (compare first half vs second half)
        mid = len(scores) // 2
        first_half_avg = sum(scores[:mid]) / mid if mid > 0 else 0
        second_half_avg = sum(scores[mid:]) / (len(scores) - mid) if (len(scores) - mid) > 0 else 0

        if second_half_avg > first_half_avg + 0.1:
            trend = 'increasing'
            trend_multiplier = 1.3
        elif second_half_avg < first_half_avg - 0.1:
            trend = 'decreasing'
            trend_multiplier = 0.7
        else:
            trend = 'stable'
            trend_multiplier = 1.0

        # Churn risk = avg frustration * trend multiplier, capped at 1
        churn_risk = min(1.0, avg_frustration * trend_multiplier)

        return {
            'churn_risk_score': round(churn_risk, 2),
            'frustration_count': len(scores),
            'avg_frustration': round(avg_frustration, 2),
            'trend': trend
        }

    except Exception as e:
        logger.error(f"[ANALYTICS] Failed to calculate churn risk for {account_id}: {e}")
        return {
            'churn_risk_score': 0,
            'frustration_count': 0,
            'avg_frustration': 0,
            'trend': 'unknown'
        }
