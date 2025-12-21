import structlog
import json
import os
from typing import Optional, Dict, Any, List, Union
from decimal import Decimal
from datetime import datetime, timedelta, timezone
from apify_client import ApifyClient
import requests
import uuid

from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.agentpress.thread_manager import ThreadManager
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.billing.credits.manager import CreditManager
from core.billing.shared.config import TOKEN_PRICE_MULTIPLIER
from core.services.supabase import DBConnection
from core.services.redis import get_client, set as redis_set, get as redis_get, delete as redis_delete
from core.sandbox.tool_base import SandboxToolsBase

# Popular actors for quick access
POPULAR_ACTORS = {
    "twitter": "apify/twitter-scraper",
    "youtube": "streamers/youtube-scraper",
    "tiktok": "clockworks/tiktok-scraper",
    "instagram": "apify/instagram-scraper",
    "reddit": "trudax/reddit-scraper",
    "linkedin": "anchor/linkedin-scraper",
    "google_maps": "compass/crawler-google-places",
    "amazon": "junglee/amazon-scraper",
}

@tool_metadata(
    display_name="Apify Scraper",
    description="Run any Apify actor to scrape websites and platforms",
    icon="Globe",
    color="bg-emerald-100 dark:bg-emerald-800/50",
    weight=145,
    visible=True,
    usage_guide="""
### APIFY UNIVERSAL SCRAPER

**CAPABILITIES:** Run 10,000+ Apify actors for:
- Social: Twitter/X, Instagram, TikTok, YouTube, LinkedIn, Reddit
- E-commerce: Amazon, eBay, Walmart, AliExpress
- Maps/Local: Google Maps, Yelp, TripAdvisor
- Any website with an existing Apify actor

**FUNCTIONS:**
1. `search_apify_actors(query, category?, limit?)` - Search Apify Store for actors
   - Example: search_apify_actors("twitter scraper")
   - Returns: List of actors with descriptions, pricing, run counts

2. `get_actor_details(actor_id)` - Get actor info, input schema, pricing
   - Example: get_actor_details("twitter") or get_actor_details("apify/twitter-scraper")
   - Returns: Actor details, input schema, pricing model
   - Use shortcuts: "twitter", "youtube", "tiktok", "instagram", "reddit", "linkedin", "google_maps", "amazon"

3. `request_apify_approval(actor_id, run_input, max_cost_usd?)` - Create approval request (REQUIRED FIRST STEP)
   - Example: request_apify_approval("twitter", {"searchTerms": ["from:elonmusk"], "maxTweets": 100})
   - IMPORTANT: Always get actor details first to understand input schema
   - Estimates cost and creates pending approval request
   - Returns approval_id - **IMMEDIATELY after calling this, use ASK tool to communicate with user**
   - Default max_cost_usd: 1.0
   - **CRITICAL: After calling request_apify_approval(), you MUST use the ASK tool with this EXACT message:**
     "I've created an approval request. Maximum cost: {X} credits (${Y.YY}). Please click the 'Approve' button in the approval card above to approve it. I cannot approve it for you - only you can approve by clicking the button in the UI."
   - **CRITICAL: DO NOT ask if they want to approve or offer options - just tell them to click the approve button.**
   - **CRITICAL: NEVER mention any 'approve' tool - there is NO such tool.**

4. `get_apify_approval_status(approval_id)` - Check approval request status
   - Use to check if approval is pending, approved, rejected, or expired
   - Returns full approval details including costs
   - **CRITICAL: If status is 'pending', tell the user: "The approval request is still pending. Please click the 'Approve' button in the UI to approve it. I cannot approve it for you - only you can approve via the UI."**
   - **CRITICAL: If status is 'expired', tell the user: "The approval request has expired. I'll create a new approval request for you."**
   - **CRITICAL: NEVER try to call any 'approve' tool - there is NO such tool. Only the user can approve by clicking the approve button in the UI.**

6. `run_apify_actor(actor_id, run_input, max_cost_usd?, approval_id)` - Start actor run (REQUIRES APPROVAL)
   - Example: run_apify_actor("twitter", {...input...}, approval_id="approval-123")
   - CRITICAL: approval_id is REQUIRED - must approve request first
   - Returns immediately with run_id - use get_actor_run_status() to check progress and get logs
   - Credits are only deducted after approval and execution
   - ⚠️ MANDATORY: After run completes, you MUST call get_actor_run_results() to fetch and display actual data

7. `get_actor_run_results(run_id, limit?, offset?)` - Get ALL results from completed run (MANDATORY AFTER RUN)
   - ⚠️ CRITICAL: You MUST call this function immediately after run_apify_actor completes successfully
   - ⚠️ CRITICAL: You MUST present the actual received data to the user - never just say "run completed"
   - This function fetches ALL results and saves them to disk
   - Returns: Complete dataset with all items, file_path (relative path), item count
   - Default limit: 100 items (use offset for pagination if needed)
   - ALWAYS call this after run completes - users need to see the actual data immediately
   - **CRITICAL: When presenting results, use 'complete' tool with the file_path as an attachment - NEVER show raw file paths in messages**

8. `get_actor_run_status(run_id)` - Get run status, logs, and details
   - Use to check status of a running or completed actor
   - Returns: status, logs, error messages, cost info
   - Poll this until status is SUCCEEDED or FAILED before calling get_actor_run_results()

9. `stop_actor_run(run_id)` - Stop/cancel a running actor
   - Use to cancel a long-running actor that's taking too long
   - Returns: confirmation of stop request

**WORKFLOW (APPROVAL REQUIRED - COMPLETE DATA DELIVERY MANDATORY):**
1. Search for actors: search_apify_actors("platform scraper")
2. Get details: get_actor_details("actor_id") to see input schema and pricing
3. Request approval: request_apify_approval("actor_id", {...input...}) - creates pending approval
4. **IMMEDIATELY use ASK tool** to communicate with user:
   - Present the approval request details (actor, estimated cost, max cost in credits)
   - Say: "I've created an approval request. Maximum cost: {X} credits ({$Y.YY}). Please click the 'Approve' button in the approval card above to approve it. I cannot approve it for you - only you can approve by clicking the button in the UI."
   - **CRITICAL: NEVER mention any 'approve' tool - there is NO such tool. The user must click the approve button in the UI.**
5. Check status: get_apify_approval_status("approval_id") to verify user has approved via UI
   - **If status is 'pending': Tell user: "The approval is still pending. Please click the 'Approve' button in the approval card above to approve it. I cannot approve it for you."**
   - **If status is 'approved': Proceed to step 6**
   - **If status is 'expired': Tell user: "The approval has expired. I'll create a new approval request." Then go back to step 3**
   - **CRITICAL: NEVER try to call any 'approve_apify_request' or 'approve' tool - it does NOT exist. Only the user can approve via UI.**
6. Start actor: run_apify_actor("actor_id", {...input...}, approval_id="approval_id") - REQUIRES approval_id
7. Monitor status: get_actor_run_status("run_id") to check progress/logs (poll until SUCCEEDED/FAILED)
8. **MANDATORY: Get and display results** - get_actor_run_results("run_id") once status is SUCCEEDED
   - ⚠️ CRITICAL: You MUST call get_actor_run_results() immediately after run completes
   - ⚠️ CRITICAL: You MUST present the ACTUAL received data to the user in your response
   - ⚠️ CRITICAL: Never just say "run completed" - always show the actual data
   - Reference specific items, counts, and key data points from the results
   - **CRITICAL: Use 'complete' tool with the file_path from results as an attachment - NEVER show raw file paths like "/workspace/.../file.json" in messages**
   - Users need to see the data immediately - don't make them ask for it
9. Stop if needed: stop_actor_run("run_id") to cancel a running actor

**COMPLETE TOOL CALL REQUIREMENT:**
- After run_apify_actor() completes successfully, you MUST make a COMPLETE tool call sequence:
  1. Call get_actor_run_status("run_id") to confirm SUCCEEDED status
  2. Call get_actor_run_results("run_id") to fetch ALL data
  3. Present the actual data to the user using 'complete' tool with:
     - Total item count
     - Key data points/examples from the results
     - **File attached (use file_path from results as attachment - NEVER show raw paths)**
     - Summary of what was scraped
- Never skip step 2 - users expect to see the data, not just confirmation that scraping worked
- Always reference actual received data: "I found X items", "Here are the results", "The data shows..."
- **CRITICAL: Always attach the file using 'complete' tool attachments parameter - never mention file paths like "/workspace/..." in messages**

**POPULAR ACTORS (shortcuts):**
- twitter, youtube, tiktok, instagram, reddit, linkedin
- google_maps, amazon

**BILLING & APPROVALS:** 
- ⚠️ ALL actor runs REQUIRE APPROVAL before execution
- Approval requests estimate costs and require user approval
- Credits are ONLY deducted after approval AND successful execution
- Apify costs passed through + 20% markup
- IMPORTANT: 1 CREDIT = 1 CENT ($0.01 USD)
- When discussing costs with users, use format: "$X.XX (XXX credits)" or "XXX credits ($X.XX)"
- Check pricing before running - some actors have no Apify cost, others charge per result/event
- Approvals expire after 24 hours - create new approval if expired
- **🚨 CRITICAL: THERE IS NO 'approve_apify_request' TOOL. IT DOES NOT EXIST.**
- **🚨 CRITICAL: YOU CANNOT APPROVE REQUESTS. ONLY THE USER CAN APPROVE BY CLICKING THE 'APPROVE' BUTTON IN THE UI.**
- **🚨 CRITICAL: If approval is pending, tell the user: "Please click the 'Approve' button in the approval card above. I cannot approve it for you."**
- **🚨 CRITICAL: NEVER try to call 'approve_apify_request' or any approve tool - it will fail because it doesn't exist.**

**EXAMPLES (COMPLETE WORKFLOW WITH DATA DELIVERY):**
- "Scrape latest tweets from @elonmusk" → 
  1. search_apify_actors("twitter")
  2. get_actor_details("twitter")
  3. request_apify_approval("twitter", {"searchTerms": ["from:elonmusk"]})
  4. **USE ASK TOOL:** "I've created an approval request for scraping tweets. Maximum cost: 120 credits ($1.00). Please click the 'Approve' button in the approval card above to approve it. I cannot approve it for you - only you can approve by clicking the button in the UI."
  5. get_apify_approval_status("approval_id") - check if user approved
     - **If pending: Tell user: "The approval is still pending. Please click the 'Approve' button in the approval card above. I cannot approve it for you."**
     - **If approved: Proceed to step 6**
  6. run_apify_actor("twitter", {"searchTerms": ["from:elonmusk"]}, approval_id="approval_id")
  7. get_actor_run_status("run_id") - poll until SUCCEEDED
  8. **MANDATORY:** get_actor_run_results("run_id") - fetch and display actual tweets
  9. Present data: "I found 50 tweets from @elonmusk. Here are the latest ones: [show actual tweet data]"

- "Get YouTube video details" → 
  1. search_apify_actors("youtube")
  2. get_actor_details("youtube")
  3. request_apify_approval("youtube", {"videoUrls": ["https://youtube.com/watch?v=..."]})
  4. **USE ASK TOOL:** "Approval request created for YouTube video details. Max cost: 60 credits ($0.50). Please click the 'Approve' button in the approval card above to approve it. I cannot approve it for you - only you can approve via the UI."
  5. get_apify_approval_status("approval_id") - check if user approved
     - **If pending: Tell user: "Please click the 'Approve' button in the approval card above. I cannot approve it for you."**
     - **If approved: Proceed to step 6**
  6. run_apify_actor("youtube", {"videoUrls": ["..."]}, approval_id="approval_id")
  7. get_actor_run_status("run_id") - poll until SUCCEEDED
  8. **MANDATORY:** get_actor_run_results("run_id") - fetch and display actual video details
  9. Present data: "Here are the video details: [show actual title, views, description, etc.]"

- "Find restaurants on Google Maps" → 
  1. search_apify_actors("google maps")
  2. get_actor_details("google_maps")
  3. request_apify_approval("google_maps", {"queries": "restaurants in NYC"})
  4. **USE ASK TOOL:** "Created approval for Google Maps search. Maximum cost: 100 credits ($1.00). Please click the 'Approve' button in the approval card above to approve it. I cannot approve it for you - only you can approve via the UI."
  5. get_apify_approval_status("approval_id") - check if user approved
     - **If pending: Tell user: "The approval is still pending. Please click the 'Approve' button in the approval card above. I cannot approve it for you."**
     - **If approved: Proceed to step 6**
  6. run_apify_actor("google_maps", {"queries": "restaurants in NYC"}, approval_id="approval_id")
  7. get_actor_run_status("run_id") - poll until SUCCEEDED
  8. **MANDATORY:** get_actor_run_results("run_id") - fetch and display actual restaurant data
  9. Present data: "I found 25 restaurants in NYC: [show actual restaurant names, addresses, ratings]"
"""
)
class ApifyTool(SandboxToolsBase):
    def __init__(self, project_id: str, thread_manager: Optional[ThreadManager] = None):
        super().__init__(project_id, thread_manager)
        self.credit_manager = CreditManager()
        self.db = DBConnection()
        
        if config.APIFY_API_TOKEN:
            # Initialize Apify client with token
            # The client handles retries automatically (up to 8 retries with exponential backoff)
            self.client = ApifyClient(token=config.APIFY_API_TOKEN)
            logger.info("Apify Tool initialized with client v2.3.0+")
        else:
            self.client = None
            logger.warning("APIFY_API_TOKEN not configured - Apify Tool will not be available")
    
    def _is_rental_actor(self, pricing_model: Optional[str] = None, pricing_infos: Optional[List[Any]] = None, current_pricing_info: Optional[Any] = None) -> bool:
        """
        Check if an actor is a rental actor (FLAT_PRICE_PER_MONTH).
        Only programmatically purchasable models are allowed:
        - PRICE_PER_DATASET_ITEM (pay per result)
        - PRICE_PER_EVENT (pay per event)
        - null/None (free actors)
        
        Returns True if actor is a rental (should be blocked), False otherwise.
        """
        # Check main pricing model
        if pricing_model == "FLAT_PRICE_PER_MONTH":
            return True
        
        # Check currentPricingInfo
        if current_pricing_info:
            if isinstance(current_pricing_info, dict):
                if current_pricing_info.get("pricingModel") == "FLAT_PRICE_PER_MONTH":
                    return True
            elif hasattr(current_pricing_info, 'pricingModel'):
                if getattr(current_pricing_info, 'pricingModel', None) == "FLAT_PRICE_PER_MONTH":
                    return True
        
        # Check pricingInfos array (most comprehensive check)
        if pricing_infos:
            if isinstance(pricing_infos, list):
                for pricing_info in pricing_infos:
                    if isinstance(pricing_info, dict):
                        if pricing_info.get("pricingModel") == "FLAT_PRICE_PER_MONTH":
                            return True
                    elif hasattr(pricing_info, 'pricingModel'):
                        if getattr(pricing_info, 'pricingModel', None) == "FLAT_PRICE_PER_MONTH":
                            return True
        
        return False
    
    async def _get_current_thread_and_user(self) -> tuple[Optional[str], Optional[str]]:
        """Get thread_id and account_id from context."""
        try:
            context_vars = structlog.contextvars.get_contextvars()
            thread_id = context_vars.get('thread_id')
            
            if not thread_id:
                logger.warning("No thread_id in execution context")
                return None, None
            
            client = await self.db.client
            thread = await client.from_('threads').select('account_id').eq('thread_id', thread_id).single().execute()
            if thread.data:
                return thread_id, thread.data.get('account_id')
                
        except Exception as e:
            logger.error(f"Failed to get thread context: {e}")
        return None, None
    
    def _resolve_actor_id(self, actor_id: str) -> str:
        """Resolve shortcut names to full actor IDs."""
        return POPULAR_ACTORS.get(actor_id.lower(), actor_id)
    
    async def _get_run_cost(self, run_info: dict) -> Decimal:
        """Extract actual cost from Apify run info."""
        try:
            # Handle both dict and object responses
            if hasattr(run_info, 'usageTotalUsd'):
                usage_total_usd = run_info.usageTotalUsd
            elif isinstance(run_info, dict):
                usage_total_usd = run_info.get("usageTotalUsd", 0)
            else:
                usage_total_usd = 0
            
            if usage_total_usd and usage_total_usd > 0:
                # Direct USD cost from Apify
                return Decimal(str(usage_total_usd))
            
            # Try to get usage details
            if hasattr(run_info, 'usage'):
                usage = run_info.usage
            elif isinstance(run_info, dict):
                usage = run_info.get("usage", {})
            else:
                usage = {}
            
            if isinstance(usage, dict) and "ACTOR_COMPUTE_UNITS" in usage:
                # Standard compute-based pricing ($0.25 per compute unit)
                compute_units = usage.get("ACTOR_COMPUTE_UNITS", 0)
                return Decimal(str(compute_units)) * Decimal("0.25")
            
            # No cost info available - return 0 (actor has no Apify cost or cost not yet calculated)
            return Decimal("0")
        except Exception as e:
            logger.warning(f"Error extracting run cost: {e}")
            return Decimal("0")
    
    async def _has_deduction_for_run(self, user_id: str, run_id: str) -> bool:
        """Check if credits have already been deducted for this run_id (database check)."""
        try:
            client = await self.db.client
            # Check if a deduction already exists for this run_id
            # The description format is: "Apify: {actor_id} (run: {run_id})"
            result = await client.from_('credit_ledger').select('id').eq(
                'account_id', user_id
            ).eq('type', 'apify_usage').like(
                'description', f'%run: {run_id}%'
            ).execute()
            
            has_deduction = result.data and len(result.data) > 0
            if has_deduction:
                logger.debug(f"Found existing deduction for run {run_id} in database")
            return has_deduction
        except Exception as e:
            logger.warning(f"Error checking for existing deduction for run {run_id}: {e}")
            # If we can't check, assume no deduction exists (safer to try deducting)
            return False
    
    async def _estimate_actor_cost(
        self,
        actor_id: str,
        run_input: dict,
        max_cost_usd: Decimal
    ) -> tuple[Decimal, Decimal]:
        """
        Estimate cost for an actor run based on pricing model and input.
        Returns (estimated_cost_usd, estimated_cost_credits_with_markup).
        Uses max_cost_usd as conservative estimate if pricing info unavailable.
        """
        try:
            # Try to get actor pricing info
            try:
                store_actor_info = self.client.store().get(actor_id)
                pricing_model = None
                pricing_infos = None
                
                if isinstance(store_actor_info, dict):
                    pricing_model = store_actor_info.get("pricingModel")
                    pricing_infos = store_actor_info.get("pricingInfos", [])
                else:
                    pricing_model = getattr(store_actor_info, 'pricingModel', None)
                    pricing_infos = getattr(store_actor_info, 'pricingInfos', None)
            except Exception:
                # If we can't get pricing info, use max_cost_usd as estimate
                logger.debug(f"Could not get pricing info for {actor_id}, using max_cost_usd as estimate")
                estimated_usd = max_cost_usd
                estimated_credits = max_cost_usd * TOKEN_PRICE_MULTIPLIER * Decimal("100")  # Convert to credits (1 credit = $0.01)
                return estimated_usd, estimated_credits
            
            # Estimate based on pricing model
            if pricing_model == "PRICE_PER_DATASET_ITEM":
                # Try to estimate based on input (e.g., maxTweets, maxResults)
                # Conservative estimate: assume we'll get some results
                price_per_item = Decimal("0.01")  # Default conservative estimate
                if pricing_infos and isinstance(pricing_infos, list) and len(pricing_infos) > 0:
                    first_pricing = pricing_infos[0]
                    if isinstance(first_pricing, dict):
                        price_per_item = Decimal(str(first_pricing.get("priceUsd", 0.01)))
                    elif hasattr(first_pricing, 'priceUsd'):
                        price_per_item = Decimal(str(getattr(first_pricing, 'priceUsd', 0.01)))
                
                # Estimate items based on input
                estimated_items = 100  # Default conservative estimate
                if isinstance(run_input, dict):
                    # Look for common input fields that indicate result count
                    for key in ['maxTweets', 'maxResults', 'maxItems', 'limit', 'count']:
                        if key in run_input:
                            try:
                                estimated_items = min(int(run_input[key]), 1000)  # Cap at 1000
                                break
                            except (ValueError, TypeError):
                                pass
                
                estimated_usd = Decimal(str(estimated_items)) * price_per_item
            elif pricing_model == "PRICE_PER_EVENT":
                # Estimate based on events (harder to predict)
                price_per_event = Decimal("0.01")
                if pricing_infos and isinstance(pricing_infos, list) and len(pricing_infos) > 0:
                    first_pricing = pricing_infos[0]
                    if isinstance(first_pricing, dict):
                        price_per_event = Decimal(str(first_pricing.get("priceUsd", 0.01)))
                    elif hasattr(first_pricing, 'priceUsd'):
                        price_per_event = Decimal(str(getattr(first_pricing, 'priceUsd', 0.01)))
                
                # Conservative estimate: assume 10-50 events
                estimated_events = 25
                estimated_usd = Decimal(str(estimated_events)) * price_per_event
            else:
                # Free actor or unknown pricing - use max_cost_usd as conservative estimate
                estimated_usd = max_cost_usd
            
            # Cap at max_cost_usd
            estimated_usd = min(estimated_usd, max_cost_usd)
            
            # Convert to credits with markup (1 credit = $0.01 USD)
            estimated_credits = estimated_usd * TOKEN_PRICE_MULTIPLIER * Decimal("100")
            
            return estimated_usd, estimated_credits
            
        except Exception as e:
            logger.warning(f"Error estimating cost for {actor_id}: {e}")
            # Fallback to max_cost_usd
            estimated_usd = max_cost_usd
            estimated_credits = max_cost_usd * TOKEN_PRICE_MULTIPLIER * Decimal("100")
            return estimated_usd, estimated_credits
    
    def _get_approval_key(self, approval_id: str) -> str:
        """Get Redis key for approval request."""
        return f"apify:approval:{approval_id}"
    
    
    async def _create_approval_request(
        self,
        account_id: str,
        thread_id: Optional[str],
        actor_id: str,
        run_input: dict,
        estimated_cost_usd: Decimal,
        estimated_cost_credits: Decimal,
        max_cost_usd: Decimal
    ) -> Optional[str]:
        """Create an approval request in Redis with 24h TTL. Returns approval_id."""
        try:
            approval_id = str(uuid.uuid4())
            expires_at = datetime.now(timezone.utc) + timedelta(hours=24)
            
            approval_data = {
                'id': approval_id,
                'account_id': account_id,
                'thread_id': thread_id,
                'actor_id': actor_id,
                'run_input': run_input,
                'estimated_cost_usd': float(estimated_cost_usd),
                'estimated_cost_credits': float(estimated_cost_credits),
                'max_cost_usd': float(max_cost_usd),
                'status': 'pending',
                'expires_at': expires_at.isoformat(),
                'created_at': datetime.now(timezone.utc).isoformat(),
                'updated_at': datetime.now(timezone.utc).isoformat()
            }
            
            # Store in Redis with 24 hour TTL (86400 seconds)
            key = self._get_approval_key(approval_id)
            await redis_set(key, json.dumps(approval_data), ex=86400)
            
            logger.info(f"Created approval request {approval_id} for actor {actor_id} (estimated: ${estimated_cost_usd:.4f} / {estimated_cost_credits:.2f} credits)")
            return approval_id
                
        except Exception as e:
            logger.error(f"Error creating approval request: {e}")
            return None
    
    async def _get_approval_request(self, approval_id: str) -> Optional[dict]:
        """Get an approval request by ID from Redis."""
        try:
            key = self._get_approval_key(approval_id)
            data = await redis_get(key)
            if data:
                return json.loads(data)
            return None
        except Exception as e:
            logger.debug(f"Error getting approval request {approval_id}: {e}")
            return None
    
    async def _check_existing_approval(
        self,
        account_id: str,
        actor_id: str,
        run_input: dict
    ) -> Optional[str]:
        """Check if there's an existing pending approval for the same actor/input. Returns approval_id if found."""
        try:
            # Scan Redis for user's pending approvals (simple approach)
            redis_client = await get_client()
            approval_ids = []
            try:
                pattern = "apify:approval:*"
                async for key in redis_client.scan_iter(match=pattern):
                    approval_id = key.split(':')[-1]
                    approval = await self._get_approval_request(approval_id)
                    if approval and approval.get('account_id') == account_id:
                        approval_ids.append(approval_id)
            except Exception as e:
                logger.debug(f"Error scanning approvals: {e}")
                return None
            
            # Check each approval
            for approval_id in approval_ids:
                approval = await self._get_approval_request(approval_id)
                if approval and approval.get('status') == 'pending':
                    if approval.get('actor_id') == actor_id and approval.get('run_input') == run_input:
                        # Check if not expired
                        expires_at_str = approval.get('expires_at')
                        if expires_at_str:
                            try:
                                expires_at = datetime.fromisoformat(expires_at_str.replace('Z', '+00:00'))
                                if datetime.now(timezone.utc) <= expires_at:
                                    return approval_id
                            except Exception:
                                pass
                        else:
                            return approval_id
            
            return None
        except Exception as e:
            logger.debug(f"Error checking existing approval: {e}")
            return None
    
    async def _deduct_apify_credits(
        self, 
        user_id: str, 
        cost: Decimal, 
        actor_id: str, 
        run_id: str, 
        thread_id: Optional[str] = None,
        approval_id: Optional[str] = None
    ) -> bool:
        """Deduct credits for Apify usage with markup. Checks database first to avoid duplicate deductions. Only deducts if approval exists."""
        if config.ENV_MODE == EnvMode.LOCAL:
            logger.info(f"LOCAL mode - skipping billing for Apify run {run_id}")
            return True
        
        # CRITICAL: Only deduct if approval exists and is approved
        if approval_id:
            approval = await self._get_approval_request(approval_id)
            if not approval or approval.get('status') != 'approved':
                logger.warning(f"Cannot deduct credits - approval {approval_id} not found or not approved")
                return False
        
        # Check if deduction already exists (database is source of truth)
        if await self._has_deduction_for_run(user_id, run_id):
            logger.info(f"Credits already deducted for run {run_id} (found in database), skipping duplicate deduction")
            return True
        
        marked_up_cost = cost * TOKEN_PRICE_MULTIPLIER
        
        try:
            result = await self.credit_manager.deduct_credits(
                account_id=user_id,
                amount=marked_up_cost,
                description=f"Apify: {actor_id} (run: {run_id})" + (f" [approval: {approval_id}]" if approval_id else ""),
                type='apify_usage',
                thread_id=thread_id
            )
            
            if result.get('success'):
                logger.info(f"Deducted ${marked_up_cost:.6f} for Apify run {run_id} (base: ${cost:.6f})")
                
                # Update approval request with actual cost
                if approval_id:
                    try:
                        approval = await self._get_approval_request(approval_id)
                        if approval:
                            approval['actual_cost_usd'] = float(cost)
                            approval['actual_cost_credits'] = float(marked_up_cost)
                            approval['status'] = 'executed'
                            approval['executed_at'] = datetime.now(timezone.utc).isoformat()
                            approval['updated_at'] = datetime.now(timezone.utc).isoformat()
                            key = self._get_approval_key(approval_id)
                            # Keep for 7 days after execution for audit trail
                            await redis_set(key, json.dumps(approval), ex=604800)  # 7 days
                    except Exception as e:
                        logger.warning(f"Failed to update approval request with actual cost: {e}")
                
                return True
            else:
                logger.warning(f"Failed to deduct credits: {result.get('error')}")
                return False
        except Exception as e:
            logger.error(f"Error deducting Apify credits: {e}")
            return False
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "search_apify_actors",
            "description": "Search the Apify Store for actors. Use this to find scrapers for specific platforms or websites.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query (e.g., 'twitter scraper', 'youtube video')"
                    },
                    "category": {
                        "type": "string",
                        "description": "Filter by category (optional)",
                        "enum": ["SOCIAL_MEDIA", "E_COMMERCE", "TRAVEL", "SEARCH_ENGINES", "NEWS"]
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 10)",
                        "default": 10
                    }
                },
                "required": ["query"]
            }
        }
    })
    async def search_apify_actors(
        self, 
        query: str, 
        category: Optional[str] = None, 
        limit: int = 10
    ) -> ToolResult:
        """Search the Apify Store for actors."""
        try:
            if not self.client:
                return self.fail_response("Apify API token not configured")
            
            if not query:
                return self.fail_response("Search query is required")
            
            # Search the Apify store
            store_response = self.client.store().list(
                search=query,
                limit=limit
            )
            
            # Handle both dict and object responses
            if hasattr(store_response, 'items'):
                items = store_response.items
                total = getattr(store_response, 'total', len(items))
            elif isinstance(store_response, dict):
                items = store_response.get("items", [])
                total = store_response.get("total", len(items))
            else:
                items = []
                total = 0
            
            actors = []
            for item in items:
                # Handle both dict and object item responses
                if isinstance(item, dict):
                    pricing_model = item.get("pricingModel")
                    current_pricing_info = item.get("currentPricingInfo", {})
                    if isinstance(current_pricing_info, dict):
                        pricing_model = current_pricing_info.get("pricingModel") or pricing_model
                    pricing_infos = item.get("pricingInfos", [])
                else:
                    # Object response
                    pricing_model = getattr(item, 'pricingModel', None)
                    current_pricing_info = getattr(item, 'currentPricingInfo', None)
                    if current_pricing_info:
                        if isinstance(current_pricing_info, dict):
                            pricing_model = current_pricing_info.get("pricingModel") or pricing_model
                        elif hasattr(current_pricing_info, 'pricingModel'):
                            pricing_model = getattr(current_pricing_info, 'pricingModel', None) or pricing_model
                    pricing_infos = getattr(item, 'pricingInfos', None)
                
                # Skip rental actors (FLAT_PRICE_PER_MONTH - not programmatically purchasable)
                if self._is_rental_actor(pricing_model, pricing_infos, current_pricing_info):
                    continue
                
                # Extract actor data
                if isinstance(item, dict):
                    
                    actor_data = {
                        "actor_id": item.get("id"),
                        "name": item.get("name"),
                        "title": item.get("title"),
                        "username": item.get("username"),
                        "description": (item.get("description") or "")[:200],
                        "pricing_model": pricing_model,
                        "run_count": item.get("stats", {}).get("runsCounter", 0) if isinstance(item.get("stats"), dict) else 0,
                        "is_featured": item.get("isFeatured", False),
                        "is_premium": item.get("isPremium", False),
                    }
                else:
                    # Object response - pricing_model already extracted above
                    actor_data = {
                        "actor_id": getattr(item, 'id', ''),
                        "name": getattr(item, 'name', ''),
                        "title": getattr(item, 'title', ''),
                        "username": getattr(item, 'username', ''),
                        "description": (getattr(item, 'description', None) or "")[:200],
                        "pricing_model": pricing_model,
                        "run_count": getattr(getattr(item, 'stats', None), 'runsCounter', 0) if hasattr(item, 'stats') else 0,
                        "is_featured": getattr(item, 'isFeatured', False),
                        "is_premium": getattr(item, 'isPremium', False),
                    }
                actors.append(actor_data)
            
            return self.success_response({
                "actors": actors,
                "total": total,
                "query": query
            })
            
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error searching Apify actors: {error_message}")
            simplified_message = f"Error searching actors: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_actor_details",
            "description": "Get detailed information about an Apify actor including input schema and pricing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "actor_id": {
                        "type": "string",
                        "description": "Actor ID (e.g., 'apify/twitter-scraper') or shortcut name (e.g., 'twitter')"
                    }
                },
                "required": ["actor_id"]
            }
        }
    })
    async def get_actor_details(self, actor_id: str) -> ToolResult:
        """Get detailed information about an Apify actor. Returns full API response as-is."""
        try:
            if not self.client:
                return self.fail_response("Apify API token not configured")
            
            # Resolve shortcut names
            resolved_id = self._resolve_actor_id(actor_id)
            
            # Helper function to serialize datetime objects to ISO strings
            def serialize_datetime(obj):
                """Recursively convert datetime objects to ISO strings."""
                if isinstance(obj, datetime):
                    return obj.isoformat()
                elif isinstance(obj, dict):
                    return {k: serialize_datetime(v) for k, v in obj.items()}
                elif isinstance(obj, list):
                    return [serialize_datetime(item) for item in obj]
                elif isinstance(obj, Decimal):
                    return float(obj)
                else:
                    return obj
            
            # Get actor details (works for both store and user actors)
            # Returns full actor object with all fields including inputSchema
            try:
                actor_info_response = self.client.actor(resolved_id).get()
                # Convert to dict if it's an object
                if isinstance(actor_info_response, dict):
                    actor_info = actor_info_response
                elif hasattr(actor_info_response, '__dict__'):
                    actor_info = actor_info_response.__dict__
                else:
                    actor_info = {}
            except Exception as e:
                return self.fail_response(f"Actor '{resolved_id}' not found: {str(e)}")
            
            # Check actor API response for rental pricing (before checking store)
            actor_pricing_infos = None
            if isinstance(actor_info, dict):
                actor_pricing_infos = actor_info.get("pricingInfos", [])
            elif hasattr(actor_info_response, 'pricingInfos'):
                actor_pricing_infos = getattr(actor_info_response, 'pricingInfos', None)
            
            # If actor is a rental, block it immediately
            if self._is_rental_actor(None, actor_pricing_infos, None):
                return self.fail_response(
                    f"❌ Actor '{resolved_id}' requires a rental subscription (FLAT_PRICE_PER_MONTH) and cannot be run programmatically.\n\n"
                    f"💡 Tip: Use search_apify_actors() to find actors with programmatically purchasable pricing models:\n"
                    f"- PRICE_PER_DATASET_ITEM (pay per result)\n"
                    f"- PRICE_PER_EVENT (pay per event)\n"
                    f"- Free actors (no pricing model)\n\n"
                    f"Rental actors are automatically filtered out from search results."
                )
            
            # Fetch input schema from actor build (ONLY WORKING METHOD)
            # The documented endpoint GET /v2/actors/{ACTOR_ID}/input-schema returns 404 - it doesn't work.
            # Working solution:
            # 1. GET /v2/acts/{ACTOR_ID}?token={TOKEN} to get latest build ID from data.taggedBuilds.latest.buildId
            # 2. GET /v2/actor-builds/{BUILD_ID}?token={TOKEN} to get inputSchema (JSON string) from data.inputSchema
            # Note: inputSchema is returned as a JSON string, not a JSON object - must parse it.
            input_schema = None
            if not input_schema:
                try:
                    api_token = config.APIFY_API_TOKEN
                    if not api_token:
                        logger.warning("APIFY_API_TOKEN not configured - cannot fetch input schema")
                    else:
                        import urllib.parse
                        # Ensure json module is accessible (imported at top of file)
                        # Reference it here to avoid scoping issues
                        _json_module = json
                        
                        # Extract username/name from actor_info
                        username = None
                        name = None
                        
                        if actor_info:
                            if isinstance(actor_info, dict):
                                username = actor_info.get("username")
                                name = actor_info.get("name")
                            else:
                                username = getattr(actor_info_response, 'username', None)
                                name = getattr(actor_info_response, 'name', None)
                        
                        # Build actor identifier candidates (try both slash and tilde formats)
                        actor_id_candidates = []
                        if username and name:
                            actor_id_candidates.append(f"{username}/{name}")  # e.g., "lukaskrivka/google-maps-with-contact-details"
                            actor_id_candidates.append(f"{username}~{name}")  # e.g., "lukaskrivka~google-maps-with-contact-details"
                        actor_id_candidates.append(resolved_id)  # Fallback to original ID
                        
                        logger.info(f"Fetching input schema via build endpoint - resolved_id: {resolved_id}, username: {username}, name: {name}")
                        
                        # Step 1: Get actor info to extract latest build ID
                        # Try each actor ID format until one works
                        build_id = None
                        for actor_id_attempt in actor_id_candidates:
                            if not actor_id_attempt:
                                continue
                            
                            encoded_actor_id = urllib.parse.quote(actor_id_attempt, safe='/~')
                            actor_url = f"https://api.apify.com/v2/acts/{encoded_actor_id}?token={api_token}"
                            logger.info(f"Trying to get actor info: {actor_url}")
                            
                            try:
                                actor_response = requests.get(actor_url, timeout=10)
                                
                                if actor_response.status_code == 200:
                                    actor_data = actor_response.json()
                                    # Extract build ID from data.taggedBuilds.latest.buildId
                                    if isinstance(actor_data, dict) and actor_data.get("data"):
                                        tagged_builds = actor_data.get("data", {}).get("taggedBuilds", {})
                                        if tagged_builds and tagged_builds.get("latest"):
                                            build_id = tagged_builds.get("latest", {}).get("buildId")
                                            if build_id:
                                                logger.info(f"✅ Found latest build ID: {build_id} for actor: {actor_id_attempt}")
                                                break
                                
                                elif actor_response.status_code == 404:
                                    logger.debug(f"Actor endpoint returned 404 for {actor_id_attempt}, trying next format")
                                    continue
                                else:
                                    logger.warning(f"Actor endpoint returned HTTP {actor_response.status_code} for {actor_id_attempt}")
                            except Exception as e:
                                logger.debug(f"Error fetching actor info for {actor_id_attempt}: {e}")
                                continue
                        
                        # Step 2: Get input schema from build if we found a build ID
                        if build_id:
                            build_url = f"https://api.apify.com/v2/actor-builds/{build_id}?token={api_token}"
                            logger.info(f"Fetching input schema from build: {build_url}")
                            
                            try:
                                build_response = requests.get(build_url, timeout=10)
                                
                                if build_response.status_code == 200:
                                    build_data = build_response.json()
                                    # Extract inputSchema from data.inputSchema (it's a JSON string)
                                    if isinstance(build_data, dict) and build_data.get("data"):
                                        input_schema_str = build_data.get("data", {}).get("inputSchema")
                                        if input_schema_str:
                                            try:
                                                # Parse the JSON string to get the actual schema object
                                                if isinstance(input_schema_str, str):
                                                    input_schema = _json_module.loads(input_schema_str)
                                                else:
                                                    input_schema = input_schema_str
                                                logger.info(f"✅ Successfully fetched and parsed input schema from build {build_id}")
                                            except ValueError as e:
                                                # json.JSONDecodeError is a subclass of ValueError
                                                logger.warning(f"Failed to parse inputSchema JSON string: {e}")
                                        else:
                                            logger.debug(f"Build {build_id} does not have inputSchema field")
                                    else:
                                        logger.warning(f"Unexpected build response structure: {build_response.text[:200]}")
                                elif build_response.status_code == 404:
                                    logger.warning(f"Build endpoint returned 404 for build ID: {build_id}")
                                else:
                                    logger.warning(f"Build endpoint returned HTTP {build_response.status_code} - Response: {build_response.text[:200]}")
                            except Exception as e:
                                logger.warning(f"Error fetching build info: {e}")
                        else:
                            logger.warning(f"Could not find latest build ID for actor {resolved_id} - input schema not available")
                            
                except Exception as e:
                    logger.warning(f"Exception fetching input schema from build endpoint: {e}", exc_info=True)
            
            # Build full response with all actor details from API + inputSchema from build endpoint
            # Start with full actor_info response
            if isinstance(actor_info, dict):
                response_data = actor_info.copy()
            elif hasattr(actor_info_response, '__dict__'):
                response_data = actor_info_response.__dict__.copy()
            else:
                response_data = {}
            
            # Ensure actor_id is set
            if not response_data.get("actor_id"):
                response_data["actor_id"] = resolved_id
            
            # CRITICAL: Add input schema if available (from build endpoint)
            if input_schema:
                response_data["inputSchema"] = input_schema
                logger.info(f"✅ Added inputSchema to response for actor {resolved_id}")
            else:
                logger.warning(f"⚠️ No inputSchema available for actor {resolved_id} - agent may not know required inputs")
                # Don't fail - still return actor details even without input schema
            
            # Ensure imageUrl/pictureUrl is available (use pictureUrl from API if imageUrl not set)
            if not response_data.get("imageUrl") and response_data.get("pictureUrl"):
                response_data["imageUrl"] = response_data["pictureUrl"]
            
            # Serialize datetime objects to ISO strings for JSON compatibility
            response_data = serialize_datetime(response_data)
            
            return self.success_response(response_data)
            
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error getting actor details: {error_message}")
            simplified_message = f"Error getting actor details: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "request_apify_approval",
            "description": "Create an approval request for running an Apify actor. REQUIRED before running any actor. Estimates cost and creates a pending approval request that must be approved by the user before execution.",
            "parameters": {
                "type": "object",
                "properties": {
                    "actor_id": {
                        "type": "string",
                        "description": "Actor ID or shortcut name"
                    },
                    "run_input": {
                        "type": "object",
                        "description": "Input for the actor (check get_actor_details for schema). Can be passed as a dict/object or JSON string."
                    },
                    "max_cost_usd": {
                        "type": "number",
                        "description": "Maximum cost limit in USD (default: 1.0)",
                        "default": 1.0
                    }
                },
                "required": ["actor_id", "run_input"]
            }
        }
    })
    async def request_apify_approval(
        self,
        actor_id: str,
        run_input: Union[dict, str],
        max_cost_usd: Union[float, str] = 1.0
    ) -> ToolResult:
        """Create an approval request for running an Apify actor."""
        try:
            if not self.client:
                return self.fail_response("Apify API token not configured")
            
            # Parse run_input if it's a JSON string
            if isinstance(run_input, str):
                try:
                    run_input = json.loads(run_input)
                except json.JSONDecodeError as e:
                    return self.fail_response(f"Invalid JSON in run_input: {str(e)}")
            elif not isinstance(run_input, dict):
                return self.fail_response(f"run_input must be a dict or JSON string, got {type(run_input).__name__}")
            
            # Parse max_cost_usd if it's a string
            if isinstance(max_cost_usd, str):
                try:
                    max_cost_usd = float(max_cost_usd)
                except ValueError:
                    return self.fail_response(f"Invalid max_cost_usd value: {max_cost_usd}")
            
            max_cost_usd_decimal = Decimal(str(max_cost_usd))
            
            # Get user context
            thread_id, user_id = await self._get_current_thread_and_user()
            
            if not user_id and config.ENV_MODE != EnvMode.LOCAL:
                return self.fail_response(
                    "No active session context. This tool requires an active agent session."
                )
            
            # Resolve shortcut names
            resolved_id = self._resolve_actor_id(actor_id)
            
            # Check for existing pending approval
            existing_approval_id = await self._check_existing_approval(user_id, resolved_id, run_input)
            if existing_approval_id:
                approval = await self._get_approval_request(existing_approval_id)
                if approval:
                    return self.success_response({
                        "approval_id": existing_approval_id,
                        "status": "pending",
                        "message": f"Found existing pending approval request. User must approve via UI before execution.",
                        "estimated_cost_usd": approval.get('estimated_cost_usd'),
                        "estimated_cost_credits": approval.get('estimated_cost_credits'),
                        "max_cost_usd": approval.get('max_cost_usd'),
                        "actor_id": resolved_id
                    })
            
            # Estimate cost
            estimated_cost_usd, estimated_cost_credits = await self._estimate_actor_cost(
                resolved_id, run_input, max_cost_usd_decimal
            )
            
            # Create approval request
            approval_id = await self._create_approval_request(
                account_id=user_id,
                thread_id=thread_id,
                actor_id=resolved_id,
                run_input=run_input,
                estimated_cost_usd=estimated_cost_usd,
                estimated_cost_credits=estimated_cost_credits,
                max_cost_usd=max_cost_usd_decimal
            )
            
            if not approval_id:
                return self.fail_response("Failed to create approval request")
            
            # Calculate max_cost_credits (max_cost_usd * 100 * 1.2 for markup)
            max_cost_credits = float(max_cost_usd_decimal * Decimal('100') * Decimal(str(TOKEN_PRICE_MULTIPLIER)))
            
            return self.success_response({
                "approval_id": approval_id,
                "status": "pending",
                "message": f"✅ Approval request created. Estimated cost: ${estimated_cost_usd:.4f} ({estimated_cost_credits:.2f} credits). Maximum cost: ${max_cost_usd:.4f} ({max_cost_credits:.2f} credits). **CRITICAL: Use ASK tool immediately to tell user: 'Please click the Approve button in the approval card above to approve this request. I cannot approve it for you - only you can approve via the UI.' DO NOT try to call any approve tool - it does NOT exist. Use get_apify_approval_status(approval_id='{approval_id}') to check if user has approved after they click the button.**",
                "estimated_cost_usd": float(estimated_cost_usd),
                "estimated_cost_credits": float(estimated_cost_credits),
                "max_cost_usd": float(max_cost_usd_decimal),
                "actor_id": resolved_id,
                "expires_at": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
            })
            
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error creating approval request: {error_message}")
            simplified_message = f"Error creating approval request: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)
    
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_apify_approval_status",
            "description": "Get the status of an Apify approval request. Use this to check if an approval is pending, approved, rejected, or expired.",
            "parameters": {
                "type": "object",
                "properties": {
                    "approval_id": {
                        "type": "string",
                        "description": "Approval ID from request_apify_approval()"
                    }
                },
                "required": ["approval_id"]
            }
        }
    })
    async def get_apify_approval_status(self, approval_id: str) -> ToolResult:
        """Get the status of an Apify approval request."""
        try:
            # Get user context
            thread_id, user_id = await self._get_current_thread_and_user()
            
            if not user_id and config.ENV_MODE != EnvMode.LOCAL:
                return self.fail_response("No active session context")
            
            # Get approval request
            approval = await self._get_approval_request(approval_id)
            if not approval:
                # If Redis key doesn't exist, treat as expired
                return self.success_response({
                    "approval_id": approval_id,
                    "status": "expired",
                    "message": f"Approval {approval_id} has expired or been removed. Create a new approval request.",
                    "actor_id": None,
                    "estimated_cost_usd": None,
                    "estimated_cost_credits": None,
                    "max_cost_usd": None,
                    "actual_cost_usd": None,
                    "actual_cost_credits": None,
                    "run_id": None,
                    "created_at": None,
                    "approved_at": None,
                    "expires_at": None
                })
            
            # Verify ownership
            if approval.get('account_id') != user_id:
                return self.fail_response("You can only view your own approval requests")
            
            # Check if expired by timestamp (even if status isn't set to expired)
            status = approval.get('status')
            expires_at_str = approval.get('expires_at')
            if expires_at_str:
                try:
                    expires_at = datetime.fromisoformat(expires_at_str.replace('Z', '+00:00'))
                    if datetime.now(timezone.utc) > expires_at:
                        status = 'expired'
                except Exception:
                    pass
            message = f"Approval {approval_id} status: {status}"
            
            if status == 'pending':
                message += ". **CRITICAL: The user must click the 'Approve' button in the UI to approve this request. Tell the user: 'Please click the Approve button in the approval card above. I cannot approve it for you - only you can approve via the UI.' DO NOT try to call any approve tool - it does NOT exist.**"
            elif status == 'approved':
                message += ". You can now call run_apify_actor() with this approval_id."
            elif status == 'rejected':
                message += ". This approval was rejected by the user."
            elif status == 'expired':
                message += ". **This approval has expired. Tell the user you'll create a new approval request, then call request_apify_approval() again.**"
            elif status == 'executed':
                message += ". This approval has been executed."
            
            return self.success_response({
                "approval_id": approval_id,
                "status": status,
                "message": message,
                "actor_id": approval.get('actor_id'),
                "estimated_cost_usd": approval.get('estimated_cost_usd'),
                "estimated_cost_credits": approval.get('estimated_cost_credits'),
                "max_cost_usd": approval.get('max_cost_usd'),
                "actual_cost_usd": approval.get('actual_cost_usd'),
                "actual_cost_credits": approval.get('actual_cost_credits'),
                "run_id": approval.get('run_id'),
                "created_at": approval.get('created_at'),
                "approved_at": approval.get('approved_at'),
                "expires_at": approval.get('expires_at')
            })
            
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error getting approval status: {error_message}")
            simplified_message = f"Error getting approval status: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "run_apify_actor",
            "description": "Start an Apify actor run (non-blocking). REQUIRES APPROVAL FIRST - use request_apify_approval() before calling this. Returns immediately with run_id. Use get_actor_run_status() to check progress and get logs. ⚠️ CRITICAL: After run completes successfully, you MUST call get_actor_run_results() to fetch and display the actual data to the user. Never just confirm completion - always show the actual results. IMPORTANT: All runs require approval before execution. Credits are only deducted after approval.",
            "parameters": {
                "type": "object",
                "properties": {
                    "actor_id": {
                        "type": "string",
                        "description": "Actor ID or shortcut name"
                    },
                    "run_input": {
                        "type": "object",
                        "description": "Input for the actor (check get_actor_details for schema). Can be passed as a dict/object or JSON string (will be parsed automatically)."
                    },
                    "max_cost_usd": {
                        "type": "number",
                        "description": "Maximum cost limit in USD (default: 1.0)",
                        "default": 1.0
                    },
                    "approval_id": {
                        "type": "string",
                        "description": "Approval ID from request_apify_approval() - REQUIRED for execution"
                    }
                },
                "required": ["actor_id", "run_input", "approval_id"]
            }
        }
    })
    async def run_apify_actor(
        self, 
        actor_id: str, 
        run_input: Union[dict, str], 
        max_cost_usd: Union[float, str] = 1.0,
        approval_id: Optional[str] = None,
        **kwargs  # Ignore unexpected args
    ) -> ToolResult:
        """Run an Apify actor (blocking, 60s timeout). REQUIRES APPROVAL FIRST. Waits up to 60 seconds for completion."""
        
        try:
            if not self.client:
                return self.fail_response("Apify API token not configured")
            
            # Parse run_input if it's a JSON string (common when LLM passes it as string)
            if isinstance(run_input, str):
                try:
                    run_input = json.loads(run_input)
                    logger.debug("Parsed run_input from JSON string")
                except json.JSONDecodeError as e:
                    return self.fail_response(f"Invalid JSON in run_input: {str(e)}")
            elif not isinstance(run_input, dict):
                return self.fail_response(f"run_input must be a dict or JSON string, got {type(run_input).__name__}")
            
            # Parse max_cost_usd if it's a string
            if isinstance(max_cost_usd, str):
                try:
                    max_cost_usd = float(max_cost_usd)
                except ValueError:
                    return self.fail_response(f"Invalid max_cost_usd value: {max_cost_usd}")
            
            max_cost_usd_decimal = Decimal(str(max_cost_usd))
            
            # Get user context for billing
            thread_id, user_id = await self._get_current_thread_and_user()
            
            if not user_id and config.ENV_MODE != EnvMode.LOCAL:
                return self.fail_response(
                    "No active session context for billing. This tool requires an active agent session."
                )
            
            # CRITICAL: Require approval before running
            if not approval_id:
                return self.fail_response(
                    "❌ Approval required before running Apify actors.\n\n"
                    "📋 Workflow:\n"
                    "1. Call request_apify_approval(actor_id, run_input, max_cost_usd) to create approval request\n"
                    "2. User approves the request\n"
                    "3. Call run_apify_actor(actor_id, run_input, max_cost_usd, approval_id) with the approval_id\n\n"
                    "This ensures users control their spending and approve costs before execution."
                )
            
            # Verify approval exists and is approved
            approval = await self._get_approval_request(approval_id)
            if not approval:
                return self.fail_response(
                    f"Approval request {approval_id} has expired or been removed. "
                    f"Please create a new approval request using request_apify_approval()."
                )
            
            # Check if expired by timestamp (even if status isn't set to expired)
            expires_at_str = approval.get('expires_at')
            if expires_at_str:
                try:
                    expires_at = datetime.fromisoformat(expires_at_str.replace('Z', '+00:00'))
                    if datetime.now(timezone.utc) > expires_at:
                        return self.fail_response(
                            f"Approval request {approval_id} has expired. "
                            f"Please create a new approval request using request_apify_approval()."
                        )
                except Exception:
                    pass
            
            if approval.get('status') != 'approved':
                return self.fail_response(
                    f"Approval request {approval_id} is not approved (status: {approval.get('status')}). "
                    f"User must approve the request via UI before execution."
                )
            
            # Verify approval matches the request
            if approval.get('actor_id') != actor_id:
                return self.fail_response(
                    f"Approval {approval_id} is for actor '{approval.get('actor_id')}', not '{actor_id}'. "
                    f"Please use the correct approval_id for this actor."
                )
            
            # Check if approval expired
            expires_at_str = approval.get('expires_at')
            if expires_at_str:
                try:
                    expires_at = datetime.fromisoformat(expires_at_str.replace('Z', '+00:00'))
                    if datetime.now(expires_at.tzinfo) > expires_at:
                        return self.fail_response(
                            f"Approval {approval_id} has expired. Please create a new approval request."
                        )
                except Exception as e:
                    logger.warning(f"Error checking approval expiration: {e}")
            
            # Resolve shortcut names
            resolved_id = self._resolve_actor_id(actor_id)
            
            # Check if actor is a rental actor before running (CRITICAL: ensure we only run programmatically purchasable actors)
            try:
                store_actor_info = self.client.store().get(resolved_id)
                pricing_model = None
                pricing_infos = None
                current_pricing_info = None
                
                if isinstance(store_actor_info, dict):
                    pricing_model = store_actor_info.get("pricingModel")
                    current_pricing_info = store_actor_info.get("currentPricingInfo", {})
                    if isinstance(current_pricing_info, dict):
                        pricing_model = current_pricing_info.get("pricingModel") or pricing_model
                    pricing_infos = store_actor_info.get("pricingInfos", [])
                else:
                    pricing_model = getattr(store_actor_info, 'pricingModel', None)
                    current_pricing_info = getattr(store_actor_info, 'currentPricingInfo', None)
                    if current_pricing_info:
                        if isinstance(current_pricing_info, dict):
                            pricing_model = current_pricing_info.get("pricingModel") or pricing_model
                        elif hasattr(current_pricing_info, 'pricingModel'):
                            pricing_model = getattr(current_pricing_info, 'pricingModel', None) or pricing_model
                    pricing_infos = getattr(store_actor_info, 'pricingInfos', None)
                
                # Use centralized rental check function
                if self._is_rental_actor(pricing_model, pricing_infos, current_pricing_info):
                    return self.fail_response(
                        f"❌ Actor '{resolved_id}' requires a rental subscription (FLAT_PRICE_PER_MONTH) and cannot be run programmatically.\n\n"
                        f"💡 Tip: Use search_apify_actors() to find actors with programmatically purchasable pricing models:\n"
                        f"- PRICE_PER_DATASET_ITEM (pay per result)\n"
                        f"- PRICE_PER_EVENT (pay per event)\n"
                        f"- Free actors (no pricing model)\n\n"
                        f"Rental actors are automatically filtered out from search results."
                    )
            except Exception as e:
                # If we can't check store info, also try checking actor API directly
                try:
                    actor_info = self.client.actor(resolved_id).get()
                    if isinstance(actor_info, dict):
                        pricing_infos = actor_info.get("pricingInfos", [])
                    else:
                        pricing_infos = getattr(actor_info, 'pricingInfos', None)
                    
                    # Check if rental actor via actor API
                    if self._is_rental_actor(None, pricing_infos, None):
                        return self.fail_response(
                            f"❌ Actor '{resolved_id}' requires a rental subscription (FLAT_PRICE_PER_MONTH) and cannot be run programmatically.\n\n"
                            f"💡 Tip: Use search_apify_actors() to find actors with programmatically purchasable pricing models."
                        )
                except Exception as e2:
                    # If we can't check either, log but continue (actor might be private/user-owned)
                    logger.debug(f"Could not check actor pricing info from store or actor API: {e}, {e2}, proceeding with run")
            
            logger.info(f"Running Apify actor: {resolved_id} (blocking, 60s timeout)")
            
            # Start the actor run
            try:
                run = self.client.actor(resolved_id).start(run_input=run_input)
                logger.info(f"Apify run started, response keys: {list(run.keys()) if isinstance(run, dict) else 'object'}")
                
            except Exception as e:
                error_message = str(e)
                logger.error(f"Error calling Apify actor: {error_message}")
                
                # Check for rental/trial expiration errors
                if "rent" in error_message.lower() or "trial" in error_message.lower() or "subscription" in error_message.lower():
                    return self.fail_response(
                        f"❌ Actor '{resolved_id}' requires a rental subscription: {error_message}\n\n"
                        f"💡 Tip: Use search_apify_actors() to find actors that don't require rentals. "
                        f"Rental actors are automatically filtered out from search results."
                    )
                
                # If it's an input validation error, suggest getting actor details first
                if "input" in error_message.lower() and ("required" in error_message.lower() or "not allowed" in error_message.lower()):
                    helpful_message = (
                        f"❌ Invalid input for actor '{resolved_id}': {error_message}\n\n"
                        f"💡 Tip: Use get_actor_details(actor_id='{resolved_id}') first to see the required input schema."
                    )
                    return self.fail_response(helpful_message)
                
                # Simplify other error messages
                simplified_message = f"Error calling actor: {error_message[:200]}"
                if len(error_message) > 200:
                    simplified_message += "..."
                return self.fail_response(simplified_message)
            
            # Extract run information (handle both dict and object responses)
            if isinstance(run, dict):
                run_id = run.get("id")
                status = run.get("status")
                dataset_id = run.get("defaultDatasetId")
            else:
                run_id = getattr(run, 'id', None)
                status = getattr(run, 'status', None)
                dataset_id = getattr(run, 'defaultDatasetId', None)
            
            if not run_id:
                return self.fail_response("Actor run started but no run ID returned")
            
            logger.info(f"✅ Apify run ID: {run_id}, initial status: {status}")
            
            # Poll for completion with 60 second timeout
            import asyncio
            import time
            start_time = time.time()
            timeout_seconds = 60
            poll_interval = 2  # Check every 2 seconds
            
            while time.time() - start_time < timeout_seconds:
                try:
                    run_info = self.client.run(run_id).get()
                    if isinstance(run_info, dict):
                        status = run_info.get("status")
                    else:
                        status = getattr(run_info, 'status', status)
                    
                    # If run finished, break out of loop
                    if status in ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]:
                        logger.info(f"Run {run_id} finished with status: {status}")
                        break
                    
                    # Wait before next poll
                    await asyncio.sleep(poll_interval)
                except Exception as e:
                    logger.warning(f"Error polling run status: {e}")
                    await asyncio.sleep(poll_interval)
            
            # Check if we timed out
            elapsed = time.time() - start_time
            timed_out = elapsed >= timeout_seconds and status == "RUNNING"
            
            if timed_out:
                logger.warning(f"Run {run_id} timed out after {elapsed:.1f}s (still RUNNING)")
            
            # Get final run info and cost
            try:
                run_info_final = self.client.run(run_id).get()
                if isinstance(run_info_final, dict):
                    status = run_info_final.get("status")
                else:
                    status = getattr(run_info_final, 'status', status)
                actual_cost = await self._get_run_cost(run_info_final if isinstance(run_info_final, dict) else (run_info_final.__dict__ if hasattr(run_info_final, '__dict__') else {}))
            except Exception as e:
                logger.debug(f"Could not get final run info: {e}")
                actual_cost = Decimal("0")
            
            # Get logs (always fetch for timeout or failures)
            log_text = ""
            if timed_out or status in ["FAILED", "ABORTED", "TIMED-OUT"]:
                try:
                    log_response = self.client.log(run_id).get()
                    if isinstance(log_response, str):
                        log_text = log_response
                    elif isinstance(log_response, bytes):
                        log_text = log_response.decode('utf-8', errors='ignore')
                    elif log_response is not None:
                        log_text = str(log_response)
                    logger.info(f"Fetched logs for run {run_id} (status: {status})")
                except Exception as e:
                    logger.debug(f"Could not fetch logs: {e}")
            
            # Update approval request with run_id
            if approval_id:
                try:
                    approval = await self._get_approval_request(approval_id)
                    if approval:
                        approval['run_id'] = run_id
                        approval['updated_at'] = datetime.now(timezone.utc).isoformat()
                        key = self._get_approval_key(approval_id)
                        # Get remaining TTL to preserve it
                        redis_client = await get_client()
                        ttl = await redis_client.ttl(key)
                        if ttl > 0:
                            await redis_set(key, json.dumps(approval), ex=ttl)
                        else:
                            await redis_set(key, json.dumps(approval), ex=86400)  # Re-set 24h if expired
                except Exception as e:
                    logger.warning(f"Failed to update approval request with run_id: {e}")
            
            # Deduct credits if run finished successfully (database check prevents duplicates)
            # CRITICAL: Only deduct if approval exists and is approved
            if status in ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"] and actual_cost > 0:
                if user_id:
                    await self._deduct_apify_credits(
                        user_id=user_id,
                        cost=actual_cost,
                        actor_id=resolved_id,
                        run_id=run_id,
                        thread_id=thread_id,
                        approval_id=approval_id
                    )
            
            # Build response message
            if timed_out:
                message = f"⏱️ Run timed out after 60 seconds (still RUNNING). Check logs below. Use get_actor_run_status(run_id='{run_id}') to check progress."
            elif status == "SUCCEEDED":
                message = f"✅ Run completed successfully! ⚠️ MANDATORY: You MUST immediately call get_actor_run_results(run_id='{run_id}') to fetch and display the actual data to the user. Never just confirm completion - always show the results."
            elif status == "FAILED":
                message = f"❌ Run failed. Check logs for details."
            elif status == "ABORTED":
                message = "🛑 Run was aborted/cancelled."
            elif status == "TIMED-OUT":
                message = "⏰ Run timed out before completion."
            elif status == "RUNNING":
                message = f"⏳ Run is still in progress. Use get_actor_run_status(run_id='{run_id}') to check progress."
            else:
                message = f"Run status: {status}"
            
            response_data = {
                "run_id": run_id,
                "actor_id": resolved_id,
                "status": status,
                "dataset_id": dataset_id,
                "cost_usd": float(actual_cost),
                "max_cost_usd": float(max_cost_usd),
                "message": message,
                "logs": log_text if log_text else None  # Include logs if timed out
            }
            
            return self.success_response(response_data)
            
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error running Apify actor: {error_message}")
            simplified_message = f"Error running actor: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_actor_run_results",
            "description": "⚠️ MANDATORY: Retrieve ALL results from a completed actor run and save them to disk. You MUST call this function immediately after run_apify_actor() completes successfully (status: SUCCEEDED). You MUST present the actual received data to the user in your response - never just say 'run completed'. Always show item counts, key data points, and examples from the results. Results are saved as JSON to /workspace/apify_results/ and can be accessed via terminal commands or Python. This is a COMPLETE tool call requirement - users expect to see the data immediately.",
            "parameters": {
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": "The run ID returned from run_apify_actor"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "DEPRECATED: All items are now saved to disk. This parameter is ignored.",
                        "default": None
                    },
                    "offset": {
                        "type": "integer",
                        "description": "DEPRECATED: All items are now saved to disk. This parameter is ignored.",
                        "default": 0
                    }
                },
                "required": ["run_id"]
            }
        }
    })
    async def get_actor_run_results(
        self, 
        run_id: str, 
        limit: Optional[int] = None, 
        offset: int = 0
    ) -> ToolResult:
        """Retrieve results from a completed actor run and save to file."""
        try:
            if not self.client:
                return self.fail_response("Apify API token not configured")
            
            # Get run info to find dataset
            try:
                run_info_response = self.client.run(run_id).get()
                # Handle both dict and object responses
                if isinstance(run_info_response, dict):
                    dataset_id = run_info_response.get("defaultDatasetId")
                    actor_id = run_info_response.get("actId")
                elif hasattr(run_info_response, 'defaultDatasetId'):
                    dataset_id = run_info_response.defaultDatasetId
                    actor_id = getattr(run_info_response, 'actId', None)
                else:
                    dataset_id = None
                    actor_id = None
            except Exception as e:
                return self.fail_response(f"Failed to get run info: {str(e)}")
            
            if not dataset_id:
                return self.fail_response(f"Run {run_id} has no dataset")
            
            # Get ALL dataset items (not paginated - save everything to file)
            dataset_client = self.client.dataset(dataset_id)
            all_items = []
            
            try:
                # Fetch all items using iterate_items (no limit)
                logger.info(f"Fetching all items from dataset {dataset_id} for run {run_id}")
                all_items = list(dataset_client.iterate_items())
                logger.info(f"Retrieved {len(all_items)} items from dataset")
            except Exception as e:
                logger.error(f"Error fetching dataset items: {e}")
                return self.fail_response(f"Failed to retrieve dataset items: {str(e)}")
            
            if not all_items:
                return self.success_response({
                    "run_id": run_id,
                    "dataset_id": dataset_id,
                    "saved_to_disk": False,
                    "file_path": None,
                    "item_count": 0,
                    "message": "No items found in dataset"
                })
            
            # Save results to file in sandbox workspace - use SandboxToolsBase._ensure_sandbox()
            sandbox = await self._ensure_sandbox()
            
            # Create apify_results directory - use workspace_path from SandboxToolsBase
            workspace_path = self.workspace_path
            results_dir = f"{workspace_path}/apify_results"
            await sandbox.fs.create_folder(results_dir, "755")
            
            # Generate filename with timestamp and run_id
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            safe_actor_id = (actor_id or "unknown").replace("/", "_").replace("~", "_") if actor_id else "unknown"
            filename = f"apify_results_{safe_actor_id}_{run_id[:12]}_{timestamp}.json"
            file_path = f"{results_dir}/{filename}"
            
            # Serialize items to JSON
            json_content = json.dumps(all_items, indent=2, ensure_ascii=False, default=str)
            json_bytes = json_content.encode('utf-8')
            
            # Save to file - this is a regular sandbox operation, should always work
            await sandbox.fs.upload_file(json_bytes, file_path)
            logger.info(f"✅ Saved {len(all_items)} items to {file_path} ({len(json_bytes)} bytes)")
            
            if workspace_path.startswith("/workspace/"):
                relative_path = file_path.replace("/workspace/", "")
            else:
                relative_path = filename
            
            return self.success_response({
                "run_id": run_id,
                "actor_id": actor_id,
                "dataset_id": dataset_id,
                "saved_to_disk": True,
                "file_path": relative_path,
                "item_count": len(all_items),
                "message": f"✅ Retrieved {len(all_items)} items. The data has been saved and attached. **When presenting results to the user, use the 'complete' tool with the file_path '{relative_path}' as an attachment - never show raw file paths in messages.**"
            })
            
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error getting actor run results: {error_message}")
            simplified_message = f"Error getting results: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_actor_run_status",
            "description": "Get detailed status, logs, and information about an actor run. Useful for monitoring long-running actors or debugging failures.",
            "parameters": {
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": "The run ID from run_apify_actor"
                    }
                },
                "required": ["run_id"]
            }
        }
    })
    async def get_actor_run_status(self, run_id: str) -> ToolResult:
        """Get detailed status, logs, and information about an actor run."""
        try:
            if not self.client:
                return self.fail_response("Apify API token not configured")
            
            # Helper function to serialize datetime objects
            def serialize_datetime(obj):
                """Recursively convert datetime objects to ISO strings."""
                if isinstance(obj, datetime):
                    return obj.isoformat()
                elif isinstance(obj, dict):
                    return {k: serialize_datetime(v) for k, v in obj.items()}
                elif isinstance(obj, list):
                    return [serialize_datetime(item) for item in obj]
                elif isinstance(obj, Decimal):
                    return float(obj)
                else:
                    return obj
            
            # Get run info
            try:
                run_info_response = self.client.run(run_id).get()
                if isinstance(run_info_response, dict):
                    run_info = run_info_response
                elif hasattr(run_info_response, '__dict__'):
                    run_info = run_info_response.__dict__
                else:
                    run_info = {}
            except Exception as e:
                return self.fail_response(f"Failed to get run info: {str(e)}")
            
            # Extract run details
            status = run_info.get("status") if isinstance(run_info, dict) else getattr(run_info_response, 'status', None)
            actor_id = run_info.get("actId") if isinstance(run_info, dict) else getattr(run_info_response, 'actId', None)
            started_at = run_info.get("startedAt") if isinstance(run_info, dict) else getattr(run_info_response, 'startedAt', None)
            finished_at = run_info.get("finishedAt") if isinstance(run_info, dict) else getattr(run_info_response, 'finishedAt', None)
            status_message = run_info.get("statusMessage") if isinstance(run_info, dict) else getattr(run_info_response, 'statusMessage', None)
            dataset_id = run_info.get("defaultDatasetId") if isinstance(run_info, dict) else getattr(run_info_response, 'defaultDatasetId', None)
            
            # Get cost info
            actual_cost = await self._get_run_cost(run_info_response if isinstance(run_info_response, dict) else (run_info_response.__dict__ if hasattr(run_info_response, '__dict__') else {}))
            
            # Deduct credits if run is finished and has cost (database check prevents duplicates)
            # Note: get_actor_run_status doesn't have approval_id, so we check if there's an approval for this run_id
            if status in ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"] and actual_cost > 0:
                # Get user context for billing
                thread_id, user_id = await self._get_current_thread_and_user()
                if user_id:
                    # Find approval request for this run_id (scan user's approvals)
                    approval_id_for_deduction = None
                    try:
                        redis_client = await get_client()
                        pattern = "apify:approval:*"
                        async for key in redis_client.scan_iter(match=pattern):
                            approval_id = key.split(':')[-1]
                            approval = await self._get_approval_request(approval_id)
                            if approval and approval.get('account_id') == user_id:
                                if approval.get('run_id') == run_id and approval.get('status') == 'approved':
                                    approval_id_for_deduction = approval_id
                                    break
                    except Exception:
                        pass
                    
                    await self._deduct_apify_credits(
                        user_id=user_id,
                        cost=actual_cost,
                        actor_id=actor_id or "unknown",
                        run_id=run_id,
                        thread_id=thread_id,
                        approval_id=approval_id_for_deduction
                    )
            
            # Get logs (plain text from Apify API)
            log_text = ""
            try:
                log_response = self.client.log(run_id).get()
                if isinstance(log_response, str):
                    log_text = log_response
                elif isinstance(log_response, bytes):
                    log_text = log_response.decode('utf-8', errors='ignore')
                elif log_response is not None:
                    log_text = str(log_response)
            except Exception as e:
                logger.debug(f"Could not fetch run logs: {e}")
            
            # Get dataset item count if available
            item_count = 0
            if dataset_id:
                try:
                    dataset_info = self.client.dataset(dataset_id).get()
                    if isinstance(dataset_info, dict):
                        item_count = dataset_info.get("itemCount", 0)
                    elif hasattr(dataset_info, 'itemCount'):
                        item_count = getattr(dataset_info, 'itemCount', 0)
                except Exception as e:
                    logger.debug(f"Could not get dataset info: {e}")
            
            # Build response message based on status
            if status == "SUCCEEDED":
                message = f"✅ Run completed successfully! Retrieved {item_count} items. ⚠️ MANDATORY: You MUST immediately call get_actor_run_results(run_id='{run_id}') to fetch and display the actual data to the user."
            elif status == "RUNNING":
                message = f"⏳ Run is still in progress. Check again in a few seconds."
            elif status == "FAILED":
                message = f"❌ Run failed. Check the logs for details."
            elif status == "ABORTED":
                message = "🛑 Run was aborted/cancelled."
            elif status == "TIMED-OUT":
                message = "⏰ Run timed out before completion."
            else:
                message = f"Run status: {status}"
            
            response_data = {
                "run_id": run_id,
                "actor_id": actor_id,
                "status": status,
                "status_message": status_message,
                "message": message,
                "started_at": started_at.isoformat() if started_at and hasattr(started_at, 'isoformat') else str(started_at) if started_at else None,
                "finished_at": finished_at.isoformat() if finished_at and hasattr(finished_at, 'isoformat') else str(finished_at) if finished_at else None,
                "cost_usd": float(actual_cost),
                "dataset_id": dataset_id,
                "item_count": item_count,
                "logs": log_text  # Full log output as plain text
            }
            
            # Serialize datetime objects
            response_data = serialize_datetime(response_data)
            
            return self.success_response(response_data)
            
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error getting actor run status: {error_message}")
            simplified_message = f"Error getting run status: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "stop_actor_run",
            "description": "Stop/cancel a running actor. Use this to cancel long-running actors that are taking too long or if you want to abort the run.",
            "parameters": {
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": "The run ID from run_apify_actor that you want to stop"
                    }
                },
                "required": ["run_id"]
            }
        }
    })
    async def stop_actor_run(self, run_id: str) -> ToolResult:
        """Stop/cancel a running actor."""
        try:
            if not self.client:
                return self.fail_response("Apify API token not configured")
            
            # Get current run status first
            try:
                run_info_response = self.client.run(run_id).get()
                if isinstance(run_info_response, dict):
                    current_status = run_info_response.get("status")
                else:
                    current_status = getattr(run_info_response, 'status', None)
                
                if current_status in ["SUCCEEDED", "SUCCEEDED_AND_TERMINATED", "FAILED", "ABORTED", "TIMED-OUT"]:
                    return self.fail_response(
                        f"Run {run_id} is already completed with status '{current_status}'. Cannot stop a completed run."
                    )
            except Exception as e:
                logger.debug(f"Could not check run status before stopping: {e}")
            
            # Stop the run
            try:
                abort_response = self.client.run(run_id).abort()
                if isinstance(abort_response, dict):
                    abort_data = abort_response
                elif hasattr(abort_response, '__dict__'):
                    abort_data = abort_response.__dict__
                else:
                    abort_data = {}
            except Exception as e:
                error_message = str(e)
                logger.error(f"Error stopping actor run: {error_message}")
                return self.fail_response(f"Failed to stop run: {error_message}")
            
            # Verify stop was successful
            try:
                run_info_response = self.client.run(run_id).get()
                if isinstance(run_info_response, dict):
                    new_status = run_info_response.get("status")
                else:
                    new_status = getattr(run_info_response, 'status', None)
            except Exception:
                new_status = None
            
            response_data = {
                "run_id": run_id,
                "status": "stop_requested",
                "message": f"Stop request sent for run {run_id}",
                "current_status": new_status
            }
            
            return self.success_response(response_data)
            
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error stopping actor run: {error_message}")
            simplified_message = f"Error stopping run: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)
