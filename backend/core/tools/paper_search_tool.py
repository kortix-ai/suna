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
from core.billing.credit_manager import CreditManager
from core.billing.config import TOKEN_PRICE_MULTIPLIER
from core.services.supabase import DBConnection

@tool_metadata(
    display_name="Research Papers",
    description="Search and analyze academic papers and scientific research",
    icon="FileText",
    color="bg-emerald-100 dark:bg-emerald-800/50",
    weight=270,
    visible=False
)
class PaperSearchTool(Tool):
    def __init__(self, thread_manager: ThreadManager):
        super().__init__()
        self.thread_manager = thread_manager
        self.api_key = config.EXA_API_KEY
        self.db = DBConnection()
        self.credit_manager = CreditManager()
        self.exa_client = None
        
        if self.api_key:
            self.exa_client = Exa(self.api_key)
            logger.info("Paper Search Tool initialized. Note: This requires an Exa Pro plan for Websets API access.")
        else:
            logger.warning("EXA_API_KEY not configured - Paper Search Tool will not be available")
    
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
                description=f"Paper search: {num_results} results",
                thread_id=thread_id
            )
            
            if result.get('success'):
                logger.info(f"Deducted ${total_cost:.2f} for paper search ({num_results} results)")
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
            "name": "paper_search",
            "description": "Search for academic papers and research documents using natural language queries and enrich with paper details. IMPORTANT: Requires Exa Pro plan and costs $0.54 per search (10 results).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language search query describing the papers you want to find. Examples: 'Machine learning papers on transformer architectures published in 2024', 'Climate change research papers from Nature journal', 'Recent AI safety papers from top conferences'"
                    },
                    "enrichment_description": {
                        "type": "string",
                        "description": "What specific information to find about each paper. Default: 'Paper abstract, authors, publication details, and key findings'",
                        "default": "Paper abstract, authors, publication details, and key findings"
                    }
                },
                "required": ["query"]
            }
        }
    })
    async def paper_search(
        self,
        query: str,
        enrichment_description: str = "Paper abstract, authors, publication details, and key findings"
    ) -> ToolResult:
        if not self.exa_client:
            return self.fail_response(
                "Paper Search is not available. EXA_API_KEY is not configured. "
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
            logger.info(f"Creating Exa webset for paper search: '{query}' with 10 results")
            
            enrichment_config = CreateEnrichmentParameters(
                description=enrichment_description,
                format="text"
            )
            
            webset_params = CreateWebsetParameters(
                search={
                    "query": query,
                    "count": 10,
                    "include_domains": ["arxiv.org", "scholar.google.com", "pubmed.ncbi.nlm.nih.gov", 
                                      "ieee.org", "acm.org", "springer.com", "nature.com", 
                                      "sciencedirect.com", "jstor.org", "researchgate.net"]
                },
                enrichments=[enrichment_config]
            )
            
            try:
                webset = await asyncio.to_thread(
                    self.exa_client.websets.create,
                    params=webset_params
                )
                
                logger.info(f"Paper webset created with ID: {webset.id}")
            except Exception as create_error:
                logger.error(f"Failed to create paper webset - Error type: {type(create_error).__name__}")
                try:
                    error_str = str(create_error)
                    logger.error(f"Failed to create paper webset - Error message: {error_str}")
                except:
                    error_str = "Unknown error"
                    logger.error(f"Failed to create paper webset - Could not convert error to string")
                
                if "401" in error_str:
                    return self.fail_response(
                        "Authentication failed with Exa API. Please check your API key and Pro plan status."
                    )
                elif "400" in error_str:
                    return self.fail_response(
                        "Invalid request to Exa API. Please check your query format."
                    )
                else:
                    return self.fail_response(
                        "Failed to create paper search webset. Please try again."
                    )
            
            logger.info(f"Waiting for paper webset {webset.id} to complete processing...")
            try:
                webset = await asyncio.to_thread(
                    self.exa_client.websets.wait_until_idle,
                    webset.id
                )
                logger.info(f"Paper webset {webset.id} processing complete")
            except Exception as wait_error:
                logger.error(f"Error waiting for paper webset: {type(wait_error).__name__}: {repr(wait_error)}")
                return self.fail_response("Failed while waiting for paper search results. Please try again.")

            logger.info(f"Retrieving paper items from webset {webset.id}...")
            try:
                items = await asyncio.to_thread(
                    self.exa_client.websets.items.list,
                    webset_id=webset.id
                )
                logger.info(f"Retrieved paper items from webset")
            except Exception as items_error:
                logger.error(f"Error retrieving paper items: {type(items_error).__name__}: {repr(items_error)}")
                return self.fail_response("Failed to retrieve paper search results. Please try again.")
            
            results = items.data if items else []
            logger.info(f"Got {len(results)} paper results from webset")
            
            formatted_results = []
            for idx, item in enumerate(results[:10], 1):
                if hasattr(item, 'model_dump'):
                    item_dict = item.model_dump()
                elif isinstance(item, dict):
                    item_dict = item
                else:
                    item_dict = vars(item) if hasattr(item, '__dict__') else {}
                
                properties = item_dict.get('properties', {})
                
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
                
                url = properties.get('url', '')
                description = properties.get('description', '')
                
                result_entry = {
                    "rank": idx,
                    "id": item_dict.get('id', ''),
                    "webset_id": item_dict.get('webset_id', ''),
                    "source": str(item_dict.get('source', '')),
                    "source_id": item_dict.get('source_id', ''),
                    "url": url,
                    "description": description,
                    "type": properties.get('type', ''),
                    "paper_details": enrichment_text,
                    "evaluations": evaluations_text,
                    "created_at": str(item_dict.get('created_at', '')),
                    "updated_at": str(item_dict.get('updated_at', ''))
                }
                
                formatted_results.append(result_entry)
            
            base_cost = Decimal('0.45')
            total_cost = base_cost * TOKEN_PRICE_MULTIPLIER
            
            if config.ENV_MODE == EnvMode.LOCAL:
                logger.info("Running in LOCAL mode - skipping billing for paper search")
                cost_deducted_str = f"${total_cost:.2f} (LOCAL - not charged)"
            else:
                credits_deducted = await self._deduct_credits(user_id, len(formatted_results), thread_id)
                if not credits_deducted:
                    return self.fail_response(
                        "Insufficient credits for paper search. "
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
            
            logger.info(f"Successfully completed paper search with {len(formatted_results)} results")
            
            try:
                json_output = json.dumps(output, indent=2, default=str)
                return self.success_response(json_output)
            except Exception as json_error:
                logger.error(f"Failed to serialize paper search output: {json_error}")
                summary = f"Found {len(formatted_results)} papers for query: {query}"
                if formatted_results:
                    summary += f"\n\nTop result:\nTitle: {formatted_results[0].get('title', 'Unknown')}\nURL: {formatted_results[0].get('url', 'Unknown')}\nDescription: {formatted_results[0].get('description', 'Unknown')[:200]}..."
                return self.success_response(summary)
                
        except asyncio.TimeoutError:
            return self.fail_response("Paper search timed out. Please try again with a simpler query.")
        except Exception as e:
            logger.error(f"Paper search failed: {repr(e)}", exc_info=True)
            return self.fail_response("An error occurred during the paper search. Please try again.")
