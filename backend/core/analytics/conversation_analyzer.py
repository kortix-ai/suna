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

from core.services.supabase import DBConnection
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
        db = DBConnection()
        client = await db.client

        result = await client.from_('conversation_analytics')\
            .select('use_case_category')\
            .not_.is_('use_case_category', None)\
            .execute()

        # Add valid DB categories (skip garbage like "action_subject")
        for r in result.data or []:
            cat = r.get('use_case_category')
            if cat and len(cat) > 3 and not cat.startswith('action_') and not cat.startswith('CREATE'):
                categories.add(cat)

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
    db = DBConnection()
    client = await db.client

    context_messages = []
    run_messages = []

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

    base_query = client.from_('messages')\
        .select('type, content, created_at')\
        .eq('thread_id', thread_id)\
        .eq('is_llm_message', True)\
        .in_('type', ['user', 'assistant', 'tool'])

    if started_at and completed_at:
        # Fetch messages for this run
        run_query = base_query\
            .gte('created_at', started_at)\
            .lte('created_at', completed_at)\
            .order('created_at', desc=False)
        run_result = await run_query.execute()
        run_messages = run_result.data or []

        # Fetch previous USER messages as context (we care about what they asked, not assistant verbosity)
        if include_context:
            context_query = client.from_('messages')\
                .select('type, content, created_at')\
                .eq('thread_id', thread_id)\
                .eq('is_llm_message', True)\
                .eq('type', 'user')\
                .lt('created_at', started_at)\
                .order('created_at', desc=True)\
                .limit(context_message_limit)
            context_result = await context_query.execute()
            # Reverse to get chronological order
            context_messages = list(reversed(context_result.data or []))
    else:
        # No agent_run_id or missing timestamps - fetch all messages
        result = await base_query.order('created_at', desc=False).execute()
        run_messages = result.data or []

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
            'user_message_count': analysis.get('user_message_count'),
            'assistant_message_count': analysis.get('assistant_message_count'),
            'conversation_duration_seconds': analysis.get('conversation_duration_seconds'),
            'agent_run_status': agent_run_status,
            'raw_analysis': json.dumps(analysis.get('raw_analysis', {})),
        }

        await client.from_('conversation_analytics').insert(record).execute()

        logger.debug(f"[ANALYTICS] Stored analysis for thread {thread_id}")
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
        db = DBConnection()
        client = await db.client

        now = datetime.utcnow()
        from_date = (now - timedelta(days=days)).isoformat()

        # First get thread_ids for this account
        threads_result = await client.from_('threads')\
            .select('thread_id')\
            .eq('account_id', account_id)\
            .execute()

        thread_ids = [t['thread_id'] for t in (threads_result.data or [])]

        if not thread_ids:
            # No threads = no activity
            return {
                'rfm_score': '1-1-1',
                'recency_score': 1,
                'frequency_score': 1,
                'monetary_score': 1,
                'churn_risk': 1.0,
                'segment': 'hibernating',
                'days_since_last_activity': days,
                'runs_in_period': 0,
                'total_conversations': 0
            }

        logger.debug(f"[RFM] Account {account_id} has {len(thread_ids)} threads")

        # Get agent runs for this account's threads in the period
        runs_result = await client.from_('agent_runs')\
            .select('started_at')\
            .in_('thread_id', thread_ids)\
            .gte('started_at', from_date)\
            .order('started_at', desc=True)\
            .execute()

        runs = runs_result.data or []
        runs_in_period = len(runs)
        logger.debug(f"[RFM] Found {runs_in_period} runs in period for account {account_id}")

        # Calculate days since last activity
        if runs:
            last_run_time = runs[0].get('started_at')
            if last_run_time:
                last_dt = datetime.fromisoformat(last_run_time.replace('Z', '+00:00'))
                days_since_last = (now - last_dt.replace(tzinfo=None)).days
            else:
                days_since_last = days  # Assume max if no timestamp
        else:
            days_since_last = days  # No runs = max days

        # Get total conversations (monetary proxy)
        total_result = await client.from_('agent_runs')\
            .select('id', count='exact')\
            .in_('thread_id', thread_ids)\
            .limit(1)\
            .execute()
        total_conversations = total_result.count or 0

        # Score Recency (1-5): fewer days since last activity = higher score
        if days_since_last <= 1:
            recency_score = 5
        elif days_since_last <= 3:
            recency_score = 4
        elif days_since_last <= 7:
            recency_score = 3
        elif days_since_last <= 14:
            recency_score = 2
        else:
            recency_score = 1

        # Score Frequency (1-5): more runs in period = higher score
        if runs_in_period >= 20:
            frequency_score = 5
        elif runs_in_period >= 10:
            frequency_score = 4
        elif runs_in_period >= 5:
            frequency_score = 3
        elif runs_in_period >= 2:
            frequency_score = 2
        else:
            frequency_score = 1

        # Score Monetary (1-5): more total conversations = higher score
        if total_conversations >= 100:
            monetary_score = 5
        elif total_conversations >= 50:
            monetary_score = 4
        elif total_conversations >= 20:
            monetary_score = 3
        elif total_conversations >= 5:
            monetary_score = 2
        else:
            monetary_score = 1

        # Derive churn risk from RFM (low R and F = high churn risk)
        # Weight recency and frequency more heavily than monetary
        avg_rf = (recency_score + frequency_score) / 2
        churn_risk = round(1 - (avg_rf - 1) / 4, 2)  # Maps 1-5 to 1.0-0.0

        # Determine segment based on RFM pattern
        rfm_sum = recency_score + frequency_score + monetary_score
        if recency_score >= 4 and frequency_score >= 4:
            segment = 'champion'
        elif recency_score >= 4 and frequency_score <= 2:
            segment = 'new_user'
        elif recency_score <= 2 and frequency_score >= 4:
            segment = 'at_risk'
        elif recency_score <= 2 and frequency_score <= 2 and monetary_score >= 3:
            segment = 'cant_lose'
        elif recency_score <= 2 and frequency_score <= 2:
            segment = 'hibernating'
        elif rfm_sum >= 12:
            segment = 'loyal'
        elif rfm_sum >= 9:
            segment = 'potential'
        elif rfm_sum >= 6:
            segment = 'needs_attention'
        else:
            segment = 'about_to_sleep'

        return {
            'rfm_score': f"{recency_score}-{frequency_score}-{monetary_score}",
            'recency_score': recency_score,
            'frequency_score': frequency_score,
            'monetary_score': monetary_score,
            'churn_risk': churn_risk,
            'segment': segment,
            'days_since_last_activity': days_since_last,
            'runs_in_period': runs_in_period,
            'total_conversations': total_conversations
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
