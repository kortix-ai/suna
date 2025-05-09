import json
from agentpress.tool import Tool, ToolResult, openapi_schema, xml_schema
from agent.tools.data_providers.PerplexityProvider import PerplexityProvider, LLMError as PerplexityLLMError
from utils.logger import logger
from typing import Optional

class PerplexitySearchTool(Tool):
    """Tool for performing deep research using Perplexity Sonar API."""

    def __init__(self):
        super().__init__(
            name="PerplexitySearch", 
            description="Performs comprehensive, expert-level research and synthesizes insights on a given topic using Perplexity Sonar Deep Research. Use this for in-depth analysis and report generation."
        )
        try:
            self.provider = PerplexityProvider()
        except ValueError as e: # Se la chiave API non è configurata
            logger.error(f"Failed to initialize PerplexitySearchTool: {e}")
            # Impedire l'utilizzo del tool se non può essere inizializzato correttamente.
            # L'agente non dovrebbe selezionare questo tool se non è utilizzabile.
            self.provider = None 
            # Potremmo anche sollevare l'eccezione per impedire il caricamento del tool,
            # ma questo potrebbe bloccare l'avvio dell'agente se la chiave non è impostata.

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "execute_perplexity_deep_search",
            "description": "Performs an in-depth research query using Perplexity Sonar Deep Research and returns a synthesized report.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The research query or topic for Perplexity to investigate."
                    },
                    "model_name": {
                        "type": "string",
                        "description": "(Optional) The Perplexity model to use. Defaults to 'sonar-deep-research'.",
                        "default": "sonar-deep-research"
                    },
                    "max_tokens": {
                        "type": "integer",
                        "description": "(Optional) Maximum number of tokens for the response. Defaults to 1024.",
                        "default": 1024
                    },
                    "temperature": {
                        "type": "number",
                        "format": "float",
                        "description": "(Optional) Sampling temperature, e.g., 0.2. Higher values make output more random."
                    },
                    "web_search_context_size": {
                        "type": "string",
                        "description": "(Optional) Context size for web search. Defaults to 'high'.",
                        "enum": ["default", "low", "high"],
                        "default": "high"
                    }
                },
                "required": ["query"]
            }
        }
    })
    @xml_schema(
        tag_name="execute-perplexity-deep-search",
        mappings=[
            {"param_name": "query", "node_type": "element", "path": "query"},
            {"param_name": "model_name", "node_type": "attribute", "path": "."},
            {"param_name": "max_tokens", "node_type": "attribute", "path": "."},
            {"param_name": "temperature", "node_type": "attribute", "path": "."},
            {"param_name": "web_search_context_size", "node_type": "attribute", "path": "."}
        ],
        example='''
<!-- 
The execute-perplexity-deep-search tool performs in-depth research on a given query.
Use this tool when you need a comprehensive analysis or a synthesized report on a topic.
-->

<!-- Example to research the impact of AI on job markets with custom temperature and context size -->
<execute-perplexity-deep-search model_name="sonar-deep-research" max_tokens="1500" temperature="0.3" web_search_context_size="high">
  <query>Provide an in-depth analysis of the impact of AI on global job markets over the next decade.</query>
</execute-perplexity-deep-search>
        '''
    )
    async def execute_perplexity_deep_search(
        self,
        query: str,
        model_name: str = "sonar-deep-research",
        max_tokens: int = 1024,
        temperature: Optional[float] = None,
        web_search_context_size: Optional[str] = "high"
    ) -> ToolResult:
        """
        Executes a deep research query using the PerplexityProvider.

        Parameters:
        - query: The research query or topic.
        - model_name: (Optional) The Perplexity model to use.
        - max_tokens: (Optional) Maximum tokens for the response.
        - temperature: (Optional) Sampling temperature.
        - web_search_context_size: (Optional) Context size for web search.
        """
        if not self.provider:
            return self.fail_response("PerplexitySearchTool is not available due to missing API key or configuration error.")

        if not query:
            return self.fail_response("Query parameter is required for Perplexity deep search.")

        logger.info(f"Executing Perplexity deep search with query: '{query}', model: '{model_name}', max_tokens: {max_tokens}, temp: {temperature}, context: {web_search_context_size}")
        
        api_params = {}
        if temperature is not None:
            api_params["temperature"] = temperature
        if web_search_context_size:
            api_params["web_search_options"] = {"search_context_size": web_search_context_size}
        # Altri parametri dall'esempio dell'utente come top_p, return_images, etc., potrebbero essere aggiunti qui in modo simile
        # se si decide di esporli tramite lo schema del tool.

        try:
            result = await self.provider.perform_deep_research(
                query=query, 
                model_name=model_name,
                max_tokens=max_tokens,
                **api_params
            )

            if result.get("error"):
                logger.error(f"Perplexity deep search failed: {result.get('error')}")
                # Se la risposta del provider contiene già uno status, potremmo usarlo
                error_detail = result.get('details', result.get('error'))
                return self.fail_response(f"Perplexity search failed: {error_detail}")
            
            # La risposta di successo da perform_deep_research è l'intero JSON
            # L'LLM si aspetta solitamente il contenuto principale, non l'intera risposta API.
            # Estraiamo il contenuto del messaggio, se presente e formattato come Chat Completions.
            if result.get("choices") and isinstance(result["choices"], list) and len(result["choices"]) > 0:
                message_content = result["choices"][0].get("message", {}).get("content")
                if message_content:
                    # Potremmo voler includere anche citazioni o altri metadati utili, 
                    # ma per ora restituiamo il contenuto principale.
                    # Per risposte complesse, l'LLM potrebbe dover fare ulteriori elaborazioni.
                    # Valutare se restituire l'intero `result` o solo `message_content`.
                    # Per ora, restituiamo una stringa JSON del risultato per dare più contesto all'LLM.
                    # o semplicemente il contenuto: return self.success_response(message_content)
                    # Includere più informazioni potrebbe essere utile per l'LLM.
                    return self.success_response(json.dumps({
                        "content": message_content,
                        "usage": result.get("usage"),
                        "citations": result.get("citations"),
                        "model_used": result.get("model")
                    }))
                else:
                    return self.fail_response("Perplexity search completed but no content found in the response.")
            else:
                logger.warning(f"Perplexity search response structure not as expected: {result}")
                # Restituisce l'intero risultato se la struttura non è quella attesa, 
                # così l'LLM ha comunque accesso ai dati.
                return self.success_response(json.dumps(result))

        except PerplexityLLMError as e:
            logger.error(f"Perplexity API error during deep search: {str(e)}", exc_info=True)
            return self.fail_response(f"Perplexity API error: {str(e)}")
        except Exception as e:
            logger.error(f"Unexpected error in PerplexitySearchTool: {str(e)}", exc_info=True)
            return self.fail_response(f"An unexpected error occurred: {str(e)}")

# Per testare il tool individualmente (richiede un ambiente con AgentPress e config)
# async def main():
#     if not config.PERPLEXITY_API_KEY: # Assumendo che config sia accessibile e caricato
#         print("PERPLEXITY_API_KEY not set. Cannot run tool test.")
#         return
    
#     tool = PerplexitySearchTool()
#     if not tool.provider: # Check se il provider è stato inizializzato
#         print("Perplexity provider not initialized in tool. Check API key.")
#         return

#     test_query = "What are the latest advancements in battery technology for electric vehicles?"
#     print(f"Testing PerplexitySearchTool with query: {test_query}")
#     result = await tool.execute_deep_search(query=test_query)
#     print(f"Tool Result:\nStatus: {result.status}")
#     if result.data:
#         try:
#             data_dict = json.loads(result.data)
#             print(f"Data: {json.dumps(data_dict, indent=2)}")
#         except json.JSONDecodeError:
#             print(f"Data (raw): {result.data}")
#     else:
#         print("No data returned.")

# if __name__ == "__main__":
#     # Questo test è più complesso da eseguire standalone perché ToolResult e config
#     # dipendono dal resto dell'applicazione AgentPress.
#     # Sarebbe meglio testarlo integrato nell'agente.
#     # asyncio.run(main())
#     print("To test PerplexitySearchTool, integrate it with the agent and run the agent.") 