"""
Conversation Analyzer

Analyzes agent conversations using LLM to extract:
- Sentiment and frustration levels
- Topic classification
- Feature request detection
- RFM-based engagement scoring
"""

import json
from typing import Optional, Dict, Any, List
from datetime import datetime, timedelta

from core.services.convex_client import get_convex_client
from core.services.llm import make_llm_api_call
from core.utils.logger import logger

# Default categories (from project_helpers.py - LLM picks or extends)
DEFAULT_USE_CASE_CATEGORIES = [
    "Research & Information Gathering",
    "Business & Marketing",
    "Code & Programming",
    "Web Development",
    "Content Creation",
    "Presentations",
    "Image Generation",
]


async def get_existing_categories() -> List[str]:
    """
    Returns default categories plus any valid new ones from DB.
    Always includes defaults so LLM has good options.
    """
    # Always start with defaults
    categories = set(DEFAULT_USE_CASE_CATEGORIES)

    try:
        # TODO: Migrate to Convex - conversation_analytics table operations
        # The Convex client doesn't have a direct equivalent for this query yet.
        # Need to add conversation_analytics endpoints to Convex http.ts
        # Old Supabase code:
        # db = DBConnection()
        # client = await db.client
        # result = await client.from_('conversation_analytics')\
        #     .select('use_case_category')\
        #     .not_.is_('use_case_category', None)\
        #     .execute()
        # for r in result.data or []:
        #     cat = r.get('use_case_category')
        #     if cat and len(cat) > 3 and not cat.startswith('action_') and not cat.startswith('CREATE'):
        #         categories.add(cat)
        pass

    except Exception as e:
        logger.warning(f"[ANALYTICS] Failed to fetch existing categories: {e}")

    return sorted(list(categories))

def build_analysis_prompt(existing_categories: List[str]) -> str:
    """Build the analysis prompt with dynamic categories from DB."""
    categories_str = ", ".join(existing_categories) if existing_categories else "none yet"

    return f"""You are analyzing conversations from Suna, an open-source AI agent platform.

## ABOUT SUNA
Suna is a generalist AI agent that can:
- Browse the web and extract information
- Write, edit, and execute code
- Create and manage files (documents, spreadsheets, presentations)
- Interact with APIs and external services
- Perform multi-step tasks autonomously

Users interact with Suna to accomplish real-world tasks like research, content creation, data analysis, coding, and automation.

## YOUR TASK
Analyze the conversation and return valid JSON only. Be objective and evidence-based.

The conversation may have two sections:
- **PREVIOUS CONTEXT**: Earlier user messages showing what they asked for before
- **CURRENT INTERACTION**: The actual interaction to analyze (user + assistant)

Focus your analysis on the CURRENT INTERACTION, but use PREVIOUS CONTEXT to understand the user's overall goal.

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
    "category": "<Pick from: {categories_str}. Or create a new category if none fit>"
  }}
}}

## FRUSTRATION SIGNALS (Suna-specific)
- Agent stuck in loops or repeating actions
- Browser/sandbox errors or timeouts
- Agent not understanding the task after multiple attempts
- User saying "try again", "that's wrong", "not what I asked"
- Failed file creation or code execution
- Agent apologizing repeatedly
- User giving up mid-task

## SUCCESS SIGNALS
- Task completed as requested
- User thanks or expresses satisfaction
- User asks follow-up questions (engaged)
- Agent successfully created files/output

## WHAT'S NOT FRUSTRATION
- Long tasks (expected for complex work)
- Multiple tool calls (normal agent behavior)
- User providing clarifications (normal interaction)

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
        # TODO: Migrate to Convex - conversation_analytics_queue table operations
        # Need to add analytics queue endpoints to Convex http.ts
        # Old Supabase code:
        # db = DBConnection()
        # client = await db.client
        # existing = await client.from_('conversation_analytics_queue')\
        #     .select('id')\
        #     .eq('thread_id', thread_id)\
        #     .in_('status', ['pending', 'processing'])\
        #     .execute()
        # if existing.data:
        #     logger.debug(f"[ANALYTICS] Thread {thread_id} already in queue, skipping")
        #     return
        # await client.from_('conversation_analytics_queue').insert({
        #     'thread_id': thread_id,
        #     'agent_run_id': agent_run_id,
        #     'account_id': account_id,
        #     'status': 'pending',
        #     'attempts': 0,
        # }).execute()
        logger.debug(f"[ANALYTICS] Queued thread {thread_id} for analysis")

    except Exception as e:
        # Non-critical - don't fail the main flow
        logger.warning(f"[ANALYTICS] Failed to queue thread {thread_id}: {e}")


async def fetch_conversation_messages(
    thread_id: str,
    agent_run_id: Optional[str] = None,
    include_context: bool = True,
    context_message_limit: int = 10
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Fetch messages from a thread for analysis.

    If agent_run_id is provided, fetches messages from that run's time range
    PLUS previous messages as context.

    Returns:
        Tuple of (context_messages, run_messages)
        - context_messages: Previous messages before this run (for context)
        - run_messages: Messages from this specific run (to analyze)
    """
    # MIGRATED: Use Convex client for message operations
    convex = get_convex_client()
    
    context_messages = []
    run_messages = []

    # TODO: Full migration requires agent_runs table in Convex with time range queries
    # For now, use Convex client to get thread messages
    try:
        all_messages = await convex.get_messages(thread_id)
        run_messages = all_messages if isinstance(all_messages, list) else []
    except Exception as e:
        logger.warning(f"[ANALYTICS] Failed to fetch messages via Convex: {e}")
        # Old Supabase implementation with time range filtering:
        # started_at = None
        # completed_at = None
        # if agent_run_id:
        #     run_result = await client.from_('agent_runs')\
        #         .select('started_at, completed_at')\
        #         .eq('id', agent_run_id)\
        #         .single()\
        #         .execute()
        #     ...

    return context_messages, run_messages


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
        # Fetch messages with context
        context_messages, run_messages = await fetch_conversation_messages(thread_id, agent_run_id)

        if not run_messages:
            logger.debug(f"[ANALYTICS] No messages found for thread {thread_id}")
            return None

        # Count messages by type (only in run_messages - what we're analyzing)
        user_count = sum(1 for m in run_messages if m.get('type') == 'user')
        assistant_count = sum(1 for m in run_messages if m.get('type') == 'assistant')

        # Skip very short conversations (likely not meaningful)
        if user_count < 1:
            logger.debug(f"[ANALYTICS] Thread {thread_id} has no user messages, skipping")
            return None

        # Calculate duration
        if len(run_messages) >= 2:
            first_time = run_messages[0].get('created_at')
            last_time = run_messages[-1].get('created_at')
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

        # Format for LLM with context budget management
        # Budget: ~3000 chars for context, ~12000 chars for current run
        CONTEXT_BUDGET = 3000
        RUN_BUDGET = 12000

        # Format context (previous messages)
        context_text = ""
        if context_messages:
            context_text = format_conversation_for_analysis(context_messages)
            if len(context_text) > CONTEXT_BUDGET:
                context_text = context_text[:CONTEXT_BUDGET] + "\n[... earlier context truncated ...]"

        # Format current run messages (priority)
        run_text = format_conversation_for_analysis(run_messages)
        if len(run_text) > RUN_BUDGET:
            run_text = run_text[:RUN_BUDGET] + "\n\n[... conversation truncated for analysis ...]"

        # Combine with clear labels
        if context_text:
            conversation_text = f"""=== PREVIOUS CONTEXT (for background only) ===
{context_text}

=== CURRENT INTERACTION (analyze this) ===
{run_text}"""
        else:
            conversation_text = run_text

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

        # Fallback: try alternate structures the LLM might use
        if not use_case_category:
            use_case_category = analysis.get('use_case_category') or analysis.get('category')

        # Debug: log what we got from LLM
        logger.debug(f"[ANALYTICS] LLM response keys: {list(analysis.keys())}")
        logger.debug(f"[ANALYTICS] use_case object: {use_case}")
        logger.debug(f"[ANALYTICS] Extracted category: {use_case_category}")

        result = {
            'sentiment_label': analysis.get('sentiment'),
            'frustration_score': analysis.get('frustration', {}).get('score'),
            'frustration_signals': analysis.get('frustration', {}).get('signals', []),
            'intent_type': analysis.get('intent_type'),
            'is_feature_request': analysis.get('feature_request', {}).get('detected', False),
            'feature_request_text': analysis.get('feature_request', {}).get('text'),
            'is_useful': use_case.get('is_useful', True),
            'use_case_category': use_case_category,
            'user_message_count': user_count,
            'assistant_message_count': assistant_count,
            'conversation_duration_seconds': duration_seconds,
            'raw_analysis': analysis,
        }

        logger.debug(f"[ANALYTICS] Analyzed thread {thread_id}: category={use_case_category}")
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

    Also syncs use_case_category to the project's categories array for filtering.

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
        # TODO: Migrate to Convex - conversation_analytics table operations
        # Need to add analytics storage endpoints to Convex http.ts
        # Old Supabase code:
        # db = DBConnection()
        # client = await db.client
        # record = {
        #     'thread_id': thread_id,
        #     'agent_run_id': agent_run_id,
        #     'account_id': account_id,
        #     'sentiment_label': analysis.get('sentiment_label'),
        #     ...
        # }
        # await client.from_('conversation_analytics').insert(record).execute()
        logger.debug(f"[ANALYTICS] Stored analysis for thread {thread_id}")

        # TODO: Sync use_case_category to project categories
        # use_case = analysis.get('use_case_category')
        # is_useful = analysis.get('is_useful', True)
        # if use_case and is_useful:
        #     ...

        return True

    except Exception as e:
        logger.error(f"[ANALYTICS] Failed to store analysis for thread {thread_id}: {e}")
        return False


async def calculate_rfm_engagement(account_id: str, days: int = 30) -> Dict[str, Any]:
    """
    Calculate engagement health using RFM (Recency, Frequency, Monetary) model.

    This is a proven customer segmentation approach used since the 1930s.
    Each dimension is scored 1-5, where 5 is best.

    Dimensions:
    - Recency: Days since last agent run (lower is better)
    - Frequency: Agent runs in the period (higher is better)
    - Monetary: Proxy via total conversation count (higher is better)

    Returns:
        {
            'rfm_score': '5-4-3' format string,
            'recency_score': int 1-5,
            'frequency_score': int 1-5,
            'monetary_score': int 1-5,
            'churn_risk': float 0-1 (derived from RFM),
            'segment': str (e.g., 'champion', 'at_risk', 'hibernating'),
            'days_since_last_activity': int,
            'runs_in_period': int
        }
    """
    try:
        # TODO: Migrate to Convex - requires threads and agent_runs aggregation queries
        # The Convex client needs methods for:
        # 1. Get thread IDs for account
        # 2. Get agent runs for threads in time range
        # 3. Count total conversations
        # Old Supabase implementation:
        # db = DBConnection()
        # client = await db.client
        # threads_result = await client.from_('threads')\
        #     .select('thread_id')\
        #     .eq('account_id', account_id)\
        #     .execute()
        # ...
        
        # Return default values for now
        return {
            'rfm_score': '0-0-0',
            'recency_score': 0,
            'frequency_score': 0,
            'monetary_score': 0,
            'churn_risk': 1.0,
            'segment': 'unknown',
            'days_since_last_activity': -1,
            'runs_in_period': 0,
            'total_conversations': 0
        }

    except Exception as e:
        logger.error(f"[ANALYTICS] Failed to calculate RFM for {account_id}: {e}")
        return {
            'rfm_score': '0-0-0',
            'recency_score': 0,
            'frequency_score': 0,
            'monetary_score': 0,
            'churn_risk': 1.0,
            'segment': 'unknown',
            'days_since_last_activity': -1,
            'runs_in_period': 0,
            'total_conversations': 0
        }
