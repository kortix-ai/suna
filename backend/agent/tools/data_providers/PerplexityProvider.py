import asyncio
# import time # Non più necessario per il polling
from typing import Dict, Any, List, Optional
import httpx

from utils.logger import logger
from utils.config import config
# from .RapidDataProviderBase import RapidDataProviderBase # Vedremo se è necessario/utile

# PERPLEXITY_API_URL = "https://api.perplexity.ai/..." # Da definire in base alla documentazione API
# DEEP_RESEARCH_ENDPOINT = "..." # Da definire

# Endpoint Placeholders - DA VERIFICARE E AGGIORNARE CON LA DOCUMENTAZIONE UFFICIALE DI PERPLEXITY
# L'URL base è gestito in _make_request, qui mettiamo solo i percorsi relativi.
DEEP_RESEARCH_START_ENDPOINT = "chat/completions" # Placeholder, basato sulla compatibilità con API OpenAI per l'avvio, ma potrebbe essere diverso per job asincroni. La documentazione dice che Sonar è compatibile con l'API Chat Completions, ma Deep Research è asincrona.
                                                # Perplexity usa 'pplx-api.perplexity.ai' come host per le chiamate dirette. `_make_request` usa api.perplexity.ai
                                                # Potrebbe essere /v0/deep_research_jobs o simile, da verificare.
DEEP_RESEARCH_STATUS_ENDPOINT_TEMPLATE = "research_jobs/{job_id}" # Placeholder, es: /v0/deep_research_jobs/{job_id}

# Valori di default per il polling
DEFAULT_POLL_INTERVAL_SECONDS = 15
DEFAULT_MAX_POLLS = 20 # (15s * 20 = 300s = 5 minuti max)

# L'endpoint per le chat completions di Perplexity
CHAT_COMPLETIONS_ENDPOINT = "chat/completions"

class PerplexityProvider: # Potrebbe ereditare da RapidDataProviderBase o un'altra classe base se appropriato
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or config.PERPLEXITY_API_KEY
        if not self.api_key:
            logger.error("Perplexity API key is not configured. Please set PERPLEXITY_API_KEY.")
            raise ValueError("Perplexity API key is not configured.")
        self.base_url = "https://api.perplexity.ai" # URL base per le API di Perplexity
        # self.client = httpx.AsyncClient(base_url=PERPLEXITY_API_URL) # O simile

    async def _make_request(self, endpoint: str, data: Optional[Dict[str, Any]] = None, method: str = "POST") -> Dict[str, Any]:
        """Helper function to make requests to the Perplexity API."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json"
        }
        
        request_url = f"{self.base_url}/{endpoint.lstrip('/')}"
        logger.debug(f"Perplexity API Request: {method} {request_url} - Data: {data}")

        async with httpx.AsyncClient(timeout=60.0) as client: # Aumentato timeout per ricerche potenzialmente lunghe
            try:
                if method.upper() == "POST":
                    response = await client.post(request_url, headers=headers, json=data)
                # Metodo GET rimosso per ora, dato che non serve per chat/completions sincrone
                # elif method.upper() == "GET":
                #     response = await client.get(request_url, headers=headers, params=params)
                else:
                    logger.error(f"Unsupported HTTP method for Perplexity: {method}")
                    raise ValueError(f"Unsupported HTTP method: {method}")
                
                response.raise_for_status()
                return response.json()
            except httpx.HTTPStatusError as e:
                logger.error(f"Perplexity API request failed ({e.response.status_code}): {e.response.text}")
                raise LLMError(f"Perplexity API Error: {e.response.status_code} - {e.response.text}") from e
            except httpx.RequestError as e:
                logger.error(f"Perplexity API request failed (RequestError): {str(e)}")
                raise LLMError(f"Perplexity API Request Error: {str(e)}") from e
            except Exception as e:
                logger.error(f"An unexpected error occurred during Perplexity API request: {str(e)}")
                raise LLMError(f"Unexpected error during Perplexity API call: {str(e)}") from e

    async def perform_deep_research(
        self, 
        query: str, 
        model_name: str = "sonar-deep-research", 
        max_tokens: Optional[int] = 1024, # Default ragionevole, può essere sovrascritto
        **kwargs
    ) -> Dict[str, Any]:
        """
        Performs a research query using Perplexity API (e.g., with sonar-deep-research model)
        via the synchronous /chat/completions endpoint.
        """
        logger.info(f"Performing Perplexity research for query: '{query}' using model '{model_name}'")

        payload = {
            "model": model_name,
            "messages": [
                {"role": "user", "content": query}
            ],
            "max_tokens": max_tokens,
            **kwargs # Per passare altri parametri come temperature, top_p, ecc.
        }

        try:
            response = await self._make_request(CHAT_COMPLETIONS_ENDPOINT, data=payload, method="POST")
            logger.info(f"Perplexity research completed for query: '{query}'")
            # La risposta dovrebbe contenere i risultati direttamente, inclusi 'choices', 'usage', 'citations'
            return response 
        except LLMError as e:
            logger.error(f"Error during Perplexity research for query '{query}': {e}")
            # Restituisce un dizionario di errore strutturato
            return {
                "error": str(e),
                "status": "failed",
                "model": model_name,
                "query": query
            }

# Classe di errore personalizzata per il provider LLM
class LLMError(Exception):
    pass

# Esempio di come potrebbe essere usato (da rimuovere o spostare nei test)
async def main():
    if not config.PERPLEXITY_API_KEY:
        logger.error("PERPLEXITY_API_KEY not set. Cannot run example.")
        # Per testare, imposta PERPLEXITY_API_KEY nel tuo .env o direttamente:
        # os.environ['PERPLEXITY_API_KEY'] = "tuachiave"
        # config.PERPLEXITY_API_KEY = "tuachiave" # Se config è già istanziato
        return

    provider = PerplexityProvider()
    try:
        test_query = "Provide an in-depth analysis of the impact of AI on global job markets over the next decade."
        logger.info(f"--- Starting example Perplexity research for query: '{test_query}' ---")
        
        # Utilizza il modello sonar-deep-research come da documentazione
        results = await provider.perform_deep_research(test_query, model_name="sonar-deep-research", max_tokens=500)
        
        logger.info("--- Perplexity Research Example Results ---")
        if results.get("choices") and not results.get("error"):
            logger.info(f"Query: {test_query}")
            logger.info(f"Model Used: {results.get('model')}")
            message_content = results["choices"][0].get("message", {}).get("content", "No content found.")
            logger.info(f"Message Content:\n{message_content}")
            logger.info(f"Usage: {results.get('usage')}")
            logger.info(f"Citations: {results.get('citations')}")
        else:
            logger.error(f"Research failed or did not return expected choices. Error: {results.get('error')}")
            logger.error(f"Full Response: {results}")

    except Exception as e:
        logger.error(f"Error in PerplexityProvider example: {e}", exc_info=True)

if __name__ == "__main__":
    # Nota: l'esempio attuale è in gran parte speculativo a causa della mancanza di dettagli 
    # sugli endpoint di deep research asincrona. 
    # Assicurati che PERPLEXITY_API_KEY sia impostata.
    asyncio.run(main()) 