import structlog
import json
import os
from typing import Optional, Dict, Any, List, Union
from decimal import Decimal
from datetime import datetime
from apify_client import ApifyClient
import requests

from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.agentpress.thread_manager import ThreadManager
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.billing.credits.manager import CreditManager
from core.billing.shared.config import TOKEN_PRICE_MULTIPLIER
from core.services.supabase import DBConnection
from core.sandbox.sandbox import get_or_start_sandbox

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

3. `run_apify_actor(actor_id, run_input, max_cost_usd?)` - Start actor run (non-blocking)
   - Example: run_apify_actor("twitter", {"searchTerms": ["from:elonmusk"], "maxTweets": 100})
   - IMPORTANT: Always get actor details first to understand input schema
   - Costs are charged - confirm with user before running
   - Returns immediately with run_id - use get_actor_run_status() to check progress and get logs
   - Default max_cost_usd: 1.0

4. `get_actor_run_results(run_id, limit?, offset?)` - Get results from completed run
   - Use if run_apify_actor returned partial results (has_more: true)
   - Default limit: 100 items

5. `get_actor_run_status(run_id)` - Get run status, logs, and details
   - Use to check status of a running or completed actor
   - Returns: status, logs, error messages, cost info

6. `stop_actor_run(run_id)` - Stop/cancel a running actor
   - Use to cancel a long-running actor that's taking too long
   - Returns: confirmation of stop request

**WORKFLOW:**
1. Search for actors: search_apify_actors("platform scraper")
2. Get details: get_actor_details("actor_id") to see input schema and pricing
3. CONFIRM cost with user before running paid actors
4. Start actor: run_apify_actor("actor_id", {...input...}) - returns immediately with run_id
5. Monitor status: get_actor_run_status("run_id") to check progress/logs (poll until SUCCEEDED/FAILED)
6. Get results: get_actor_run_results("run_id") once status is SUCCEEDED
7. Stop if needed: stop_actor_run("run_id") to cancel a running actor

**POPULAR ACTORS (shortcuts):**
- twitter, youtube, tiktok, instagram, reddit, linkedin
- google_maps, amazon

**BILLING:** 
- Apify costs passed through + 20% markup
- Costs deducted from user credits automatically
- IMPORTANT: 1 CREDIT = 1 CENT ($0.01 USD)
- When discussing costs with users, use format: "$X.XX (XXX credits)" or "XXX credits ($X.XX)"
- Check pricing before running - some actors have no Apify cost, others charge per result/event

**EXAMPLES:**
- "Scrape latest tweets from @elonmusk" → search_apify_actors("twitter"), get_actor_details("twitter"), run_apify_actor("twitter", {"searchTerms": ["from:elonmusk"]})
- "Get YouTube video details" → search_apify_actors("youtube"), get_actor_details("youtube"), run_apify_actor("youtube", {"videoUrls": ["https://youtube.com/watch?v=..."]})
- "Find restaurants on Google Maps" → search_apify_actors("google maps"), get_actor_details("google_maps"), run_apify_actor("google_maps", {"queries": "restaurants in NYC"})
"""
)
class ApifyTool(Tool):
    def __init__(self, thread_manager: ThreadManager):
        super().__init__()
        self.thread_manager = thread_manager
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
    
    async def _deduct_apify_credits(
        self, 
        user_id: str, 
        cost: Decimal, 
        actor_id: str, 
        run_id: str, 
        thread_id: Optional[str] = None
    ) -> bool:
        """Deduct credits for Apify usage with markup. Checks database first to avoid duplicate deductions."""
        if config.ENV_MODE == EnvMode.LOCAL:
            logger.info(f"LOCAL mode - skipping billing for Apify run {run_id}")
            return True
        
        # Check if deduction already exists (database is source of truth)
        if await self._has_deduction_for_run(user_id, run_id):
            logger.info(f"Credits already deducted for run {run_id} (found in database), skipping duplicate deduction")
            return True
        
        marked_up_cost = cost * TOKEN_PRICE_MULTIPLIER
        
        try:
            result = await self.credit_manager.deduct_credits(
                account_id=user_id,
                amount=marked_up_cost,
                description=f"Apify: {actor_id} (run: {run_id})",
                type='apify_usage',
                thread_id=thread_id
            )
            
            if result.get('success'):
                logger.info(f"Deducted ${marked_up_cost:.6f} for Apify run {run_id} (base: ${cost:.6f})")
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
            "name": "run_apify_actor",
            "description": "Start an Apify actor run (non-blocking). Returns immediately with run_id. Use get_actor_run_status() to check progress and get logs. IMPORTANT: Costs will be charged. Get actor details first to understand pricing.",
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
                    }
                },
                "required": ["actor_id", "run_input"]
            }
        }
    })
    async def run_apify_actor(
        self, 
        actor_id: str, 
        run_input: Union[dict, str], 
        max_cost_usd: Union[float, str] = 1.0,
        **kwargs  # Ignore unexpected args
    ) -> ToolResult:
        """Run an Apify actor (blocking, 60s timeout). Waits up to 60 seconds for completion."""
        
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
            
            # Get user context for billing
            thread_id, user_id = await self._get_current_thread_and_user()
            
            if not user_id and config.ENV_MODE != EnvMode.LOCAL:
                return self.fail_response(
                    "No active session context for billing. This tool requires an active agent session."
                )
            
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
            
            # Deduct credits if run finished successfully (database check prevents duplicates)
            if status in ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"] and actual_cost > 0:
                if user_id:
                    await self._deduct_apify_credits(
                        user_id=user_id,
                        cost=actual_cost,
                        actor_id=resolved_id,
                        run_id=run_id,
                        thread_id=thread_id
                    )
            
            # Build response message
            if timed_out:
                message = f"⏱️ Run timed out after 60 seconds (still RUNNING). Check logs below. Use get_actor_run_status(run_id='{run_id}') to check progress."
            elif status == "SUCCEEDED":
                message = f"✅ Run completed successfully! Use get_actor_run_results(run_id='{run_id}') to get the data."
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
            "description": "Retrieve ALL results from a completed actor run and save them to a file in /workspace/apify_results/. Results are saved as JSON and can be accessed via terminal commands or Python. Use this after run_apify_actor completes successfully.",
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
            
            # Save results to file in sandbox workspace - NO FALLBACKS, MUST SUCCEED
            # Use same pattern as SandboxToolsBase for consistency
            if not self.thread_manager:
                return self.fail_response("No thread manager available - cannot save results to disk")
            
            project_id = self.thread_manager.project_id
            if not project_id:
                return self.fail_response("No project context available - cannot save results to disk")
            
            # Get database client from thread_manager (same pattern as SandboxToolsBase)
            client = await self.thread_manager.db.client
            
            # Get sandbox_id from project
            project_result = await client.table('projects').select('sandbox').eq('project_id', project_id).execute()
            if not project_result.data or not project_result.data[0].get('sandbox') or not project_result.data[0]['sandbox'].get('id'):
                return self.fail_response("Project has no sandbox - cannot save results to disk")
            
            sandbox_id = project_result.data[0]['sandbox']['id']
            
            # Get sandbox for this project (same pattern as SandboxToolsBase)
            sandbox = await get_or_start_sandbox(sandbox_id)
            if not sandbox:
                return self.fail_response("Could not access sandbox - cannot save results to disk")
            
            # Create apify_results directory
            results_dir = "/workspace/apify_results"
            await sandbox.fs.create_folder(results_dir, "755")
            
            # Generate filename with timestamp and run_id
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            safe_actor_id = (actor_id or "unknown").replace("/", "_").replace("~", "_") if actor_id else "unknown"
            filename = f"apify_results_{safe_actor_id}_{run_id[:12]}_{timestamp}.json"
            file_path = f"{results_dir}/{filename}"
            
            # Serialize items to JSON
            json_content = json.dumps(all_items, indent=2, ensure_ascii=False, default=str)
            json_bytes = json_content.encode('utf-8')
            
            # Save to file - this is a regular sandbox operation, should always work
            await sandbox.fs.upload_file(json_bytes, file_path)
            logger.info(f"✅ Saved {len(all_items)} items to {file_path} ({len(json_bytes)} bytes)")
            
            # Return relative path (without /workspace prefix) for frontend
            relative_path = file_path.replace("/workspace/", "")
            
            return self.success_response({
                "run_id": run_id,
                "actor_id": actor_id,
                "dataset_id": dataset_id,
                "saved_to_disk": True,
                "file_path": relative_path,
                "item_count": len(all_items),
                "message": f"✅ Retrieved {len(all_items)} items and saved to {relative_path}. Use terminal commands or Python to read the file."
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
            if status in ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"] and actual_cost > 0:
                # Get user context for billing
                thread_id, user_id = await self._get_current_thread_and_user()
                if user_id:
                    await self._deduct_apify_credits(
                        user_id=user_id,
                        cost=actual_cost,
                        actor_id=actor_id or "unknown",
                        run_id=run_id,
                        thread_id=thread_id
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
                message = f"✅ Run completed successfully! Retrieved {item_count} items. Use get_actor_run_results(run_id='{run_id}') to get the data."
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
