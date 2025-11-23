from typing import Optional
import asyncio
import structlog
import json
from decimal import Decimal
from exa_py import Exa
from exa_py.websets.types import CreateWebsetParameters, CreateEnrichmentParameters
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.agentpress.thread_manager import ThreadManager
from core.billing.credits.manager import CreditManager
from core.billing.shared.config import TOKEN_PRICE_MULTIPLIER
from core.services.supabase import DBConnection

@tool_metadata(
    display_name="People Research",
    description="Find and research people with professional background information",
    icon="Users",
    color="bg-sky-100 dark:bg-sky-800/50",
    weight=250,
    visible=True
)
class PeopleSearchTool(Tool):
    def __init__(self, thread_manager: ThreadManager):
        super().__init__()
        self.thread_manager = thread_manager
        self.api_key = config.EXA_API_KEY
        self.db = DBConnection()
        self.credit_manager = CreditManager()
        self.exa_client = None
        
        if self.api_key:
            self.exa_client = Exa(self.api_key)
            logger.info("People Search Tool initialized.")
        else:
            logger.warning("EXA_API_KEY not configured - People Search Tool will not be available")
    
    async def _get_current_thread_and_user(self) -> tuple[Optional[str], Optional[str]]:
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
    
    async def _deduct_credits(self, user_id: str, num_results: int, thread_id: Optional[str] = None) -> bool:
        base_cost = Decimal('0.45')
        total_cost = base_cost * TOKEN_PRICE_MULTIPLIER
        
        try:
            result = await self.credit_manager.use_credits(
                account_id=user_id,
                amount=total_cost,
                description=f"People search: {num_results} results",
                thread_id=thread_id
            )
            
            if result.get('success'):
                logger.info(f"Deducted ${total_cost:.2f} for people search ({num_results} results)")
                return True
            else:
                logger.warning(f"Failed to deduct credits: {result.get('error')}")
                return False
                
        except Exception as e:
            logger.error(f"Error deducting credits: {e}")
            return False

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "people_search",
            "description": "Search for people using natural language queries and enrich with LinkedIn profiles. IMPORTANT: This search costs $0.54 per search (10 results).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language search query describing the people you want to find. Examples: 'CTOs at AI startups in San Francisco', 'Senior Python developers with machine learning experience at Google', 'Marketing managers at Fortune 500 companies in New York'"
                    },
                    "enrichment_description": {
                        "type": "string",
                        "description": "What specific information to find about each person. Default: 'LinkedIn profile URL'",
                        "default": "LinkedIn profile URL"
                    }
                },
                "required": ["query"]
            }
        }
    })
    async def people_search(
        self,
        query: str,
        enrichment_description: str = "LinkedIn profile URL"
    ) -> ToolResult:
        if not self.exa_client:
            return self.fail_response(
                "People Search is not available. EXA_API_KEY is not configured. "
                "Please contact your administrator to enable this feature."
            )
        
        if not query:
            return self.fail_response("Search query is required.")
        
        thread_id, user_id = await self._get_current_thread_and_user()
        
        if config.ENV_MODE != EnvMode.LOCAL and (not thread_id or not user_id):
            return self.fail_response(
                "No active session context for billing. This tool requires an active agent session."
            )
        
        try:
            logger.info(f"Creating Exa webset for: '{query}' with 10 results")
            
            enrichment_config = CreateEnrichmentParameters(
                description=enrichment_description,
                format="text"
            )
            
            webset_params = CreateWebsetParameters(
                search={
                    "query": query,
                    "count": 10
                },
                enrichments=[enrichment_config]
            )
            
            try:
                webset = await asyncio.to_thread(
                    self.exa_client.websets.create,
                    params=webset_params
                )
                
                logger.info(f"Webset created with ID: {webset.id}")
            except Exception as create_error:
                logger.error(f"Failed to create webset - Error type: {type(create_error).__name__}")
                try:
                    error_str = str(create_error)
                    logger.error(f"Failed to create webset - Error message: {error_str}")
                except:
                    error_str = "Unknown error"
                    logger.error(f"Failed to create webset - Could not convert error to string")
                
                if "401" in error_str:
                    return self.fail_response(
                        "Authentication failed with Exa API. Please check your API key configuration."
                    )
                elif "400" in error_str:
                    return self.fail_response(
                        "Invalid request to Exa API. Please check your query format."
                    )
                else:
                    return self.fail_response(
                        "Failed to create webset. Please try again."
                    )
            
            logger.info(f"Waiting for webset {webset.id} to complete processing...")
            try:
                webset = await asyncio.to_thread(
                    self.exa_client.websets.wait_until_idle,
                    webset.id
                )
                logger.info(f"Webset {webset.id} processing complete")
            except Exception as wait_error:
                logger.error(f"Error waiting for webset: {type(wait_error).__name__}: {repr(wait_error)}")
                return self.fail_response("Failed while waiting for search results. Please try again.")

            logger.info(f"Retrieving items from webset {webset.id}...")
            try:
                items = await asyncio.to_thread(
                    self.exa_client.websets.items.list,
                    webset_id=webset.id
                )
                logger.info(f"Retrieved items from webset")
            except Exception as items_error:
                logger.error(f"Error retrieving items: {type(items_error).__name__}: {repr(items_error)}")
                return self.fail_response("Failed to retrieve search results. Please try again.")
            
            results = items.data if items else []
            logger.info(f"Got {len(results)} results from webset")
            
            formatted_results = []
            for idx, item in enumerate(results[:10], 1):
                if hasattr(item, 'model_dump'):
                    item_dict = item.model_dump()
                elif isinstance(item, dict):
                    item_dict = item
                else:
                    item_dict = vars(item) if hasattr(item, '__dict__') else {}
                
                properties = item_dict.get('properties', {})
                person_info = properties.get('person', {})
                
                evaluations_text = ""
                evaluations = item_dict.get('evaluations', [])
                if evaluations:
                    eval_items = []
                    for eval_item in evaluations:
                        if isinstance(eval_item, dict):
                            criterion = eval_item.get('criterion', '')
                            satisfied = eval_item.get('satisfied', '')
                            if criterion:
                                eval_items.append(f"{criterion}: {satisfied}")
                    evaluations_text = " | ".join(eval_items)
                
                enrichment_text = ""
                if 'enrichments' in item_dict and item_dict['enrichments']:
                    enrichments = item_dict['enrichments']
                    if isinstance(enrichments, list) and len(enrichments) > 0:
                        enrichment = enrichments[0]
                        if isinstance(enrichment, dict):
                            enrich_result = enrichment.get('result')
                            if enrich_result is not None:
                                if isinstance(enrich_result, list) and enrich_result:
                                    enrichment_text = str(enrich_result[0]) if enrich_result[0] else ""
                                elif isinstance(enrich_result, str):
                                    enrichment_text = enrich_result
                                else:
                                    enrichment_text = str(enrich_result) if enrich_result else ""
                
                picture_url = person_info.get('picture_url', '')
                if picture_url is None:
                    picture_url = ''
                
                result_entry = {
                    "rank": idx,
                    "id": item_dict.get('id', ''),
                    "webset_id": item_dict.get('webset_id', ''),
                    "source": str(item_dict.get('source', '')),
                    "source_id": item_dict.get('source_id', ''),
                    "url": properties.get('url', ''),
                    "type": properties.get('type', ''),
                    "description": properties.get('description', ''),
                    "person_name": person_info.get('name', ''),
                    "person_location": person_info.get('location', ''),
                    "person_position": person_info.get('position', ''),
                    "person_picture_url": str(picture_url) if picture_url else '',
                    "evaluations": evaluations_text,
                    "enrichment_data": enrichment_text,
                    "created_at": str(item_dict.get('created_at', '')),
                    "updated_at": str(item_dict.get('updated_at', ''))
                }
                
                formatted_results.append(result_entry)
            
            base_cost = Decimal('0.45')
            total_cost = base_cost * TOKEN_PRICE_MULTIPLIER
            
            if config.ENV_MODE == EnvMode.LOCAL:
                logger.info("Running in LOCAL mode - skipping billing for people search")
                cost_deducted_str = f"${total_cost:.2f} (LOCAL - not charged)"
            else:
                credits_deducted = await self._deduct_credits(user_id, len(formatted_results), thread_id)
                if not credits_deducted:
                    return self.fail_response(
                        "Insufficient credits for people search. "
                        f"This search costs ${total_cost:.2f} ({len(formatted_results)} results). "
                        "Please add credits to continue."
                    )
                cost_deducted_str = f"${total_cost:.2f}"
            
            output = {
                "query": query,
                "total_results": len(formatted_results),
                "cost_deducted": cost_deducted_str,
                "results": formatted_results,
                "enrichment_type": enrichment_description
            }
            
            logger.info(f"Successfully completed people search with {len(formatted_results)} results")
            
            try:
                json_output = json.dumps(output, indent=2, default=str)
                return self.success_response(json_output)
            except Exception as json_error:
                logger.error(f"Failed to serialize output: {json_error}")
                summary = f"Found {len(formatted_results)} results for query: {query}"
                if formatted_results:
                    summary += f"\n\nTop result:\nName: {formatted_results[0].get('person_name', 'Unknown')}\nPosition: {formatted_results[0].get('person_position', 'Unknown')}\nLocation: {formatted_results[0].get('person_location', 'Unknown')}"
                return self.success_response(summary)
                
        except asyncio.TimeoutError:
            return self.fail_response("Search timed out. Please try again with a simpler query.")
        except Exception as e:
            logger.error(f"People search failed: {repr(e)}", exc_info=True)
            return self.fail_response("An error occurred during the search. Please try again.")
