import asyncio
from typing import List, Optional, Dict, Any
from abc import ABC, abstractmethod
from core.utils.logger import logger
from core.utils.config import config

class EmbeddingProvider(ABC):
    @abstractmethod
    async def embed(self, texts: List[str]) -> List[List[float]]:
        pass
    
    @abstractmethod
    async def embed_single(self, text: str) -> List[float]:
        pass

class OpenAIEmbeddingProvider(EmbeddingProvider):
    def __init__(self, model: str = "text-embedding-3-small", api_key: Optional[str] = None):
        self.model = model
        self.api_key = api_key or config.OPENAI_API_KEY
        self._client = None
    
    @property
    def client(self):
        if self._client is None:
            try:
                from openai import AsyncOpenAI
                self._client = AsyncOpenAI(api_key=self.api_key)
            except ImportError:
                logger.error("OpenAI package not installed. Install with: pip install openai")
                raise
        return self._client
    
    async def embed(self, texts: List[str]) -> List[List[float]]:
        try:
            response = await self.client.embeddings.create(
                model=self.model,
                input=texts
            )
            return [embedding.embedding for embedding in response.data]
        except Exception as e:
            logger.error(f"OpenAI embedding error: {str(e)}")
            raise
    
    async def embed_single(self, text: str) -> List[float]:
        embeddings = await self.embed([text])
        return embeddings[0]

class VoyageAIEmbeddingProvider(EmbeddingProvider):
    def __init__(self, model: str = "voyage-2", api_key: Optional[str] = None):
        self.model = model
        self.api_key = api_key or config.VOYAGE_API_KEY
        self._client = None
    
    @property
    def client(self):
        if self._client is None:
            try:
                import voyageai
                self._client = voyageai.Client(api_key=self.api_key)
            except ImportError:
                logger.error("VoyageAI package not installed. Install with: pip install voyageai")
                raise
        return self._client
    
    async def embed(self, texts: List[str]) -> List[List[float]]:
        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None,
                lambda: self.client.embed(texts, model=self.model)
            )
            return result.embeddings
        except Exception as e:
            logger.error(f"Voyage AI embedding error: {str(e)}")
            raise
    
    async def embed_single(self, text: str) -> List[float]:
        embeddings = await self.embed([text])
        return embeddings[0]

class LocalEmbeddingProvider(EmbeddingProvider):
    def __init__(self, model: str = "all-MiniLM-L6-v2"):
        self.model = model
        self._model_instance = None
    
    @property
    def model_instance(self):
        if self._model_instance is None:
            try:
                from sentence_transformers import SentenceTransformer
                self._model_instance = SentenceTransformer(self.model)
            except ImportError:
                logger.error("sentence-transformers not installed. Install with: pip install sentence-transformers")
                raise
        return self._model_instance
    
    async def embed(self, texts: List[str]) -> List[List[float]]:
        try:
            loop = asyncio.get_event_loop()
            embeddings = await loop.run_in_executor(
                None,
                lambda: self.model_instance.encode(texts, convert_to_numpy=True)
            )
            return embeddings.tolist()
        except Exception as e:
            logger.error(f"Local embedding error: {str(e)}")
            raise
    
    async def embed_single(self, text: str) -> List[float]:
        embeddings = await self.embed([text])
        return embeddings[0]

class EmbeddingService:
    def __init__(self, provider: Optional[str] = None, model: Optional[str] = None):
        self.provider_name = provider or config.MEMORY_EMBEDDING_PROVIDER or "openai"
        self.model = model
        self._provider = None
    
    @property
    def provider(self) -> EmbeddingProvider:
        if self._provider is None:
            self._provider = self._create_provider()
        return self._provider
    
    def _create_provider(self) -> EmbeddingProvider:
        provider_name = self.provider_name.lower()
        
        if provider_name == "openai":
            model = self.model or config.MEMORY_EMBEDDING_MODEL or "text-embedding-3-small"
            logger.info(f"Using OpenAI embedding provider with model: {model}")
            return OpenAIEmbeddingProvider(model=model)
        
        elif provider_name == "voyage" or provider_name == "voyageai":
            model = self.model or "voyage-2"
            logger.info(f"Using Voyage AI embedding provider with model: {model}")
            return VoyageAIEmbeddingProvider(model=model)
        
        elif provider_name == "local":
            model = self.model or "all-MiniLM-L6-v2"
            logger.info(f"Using local embedding provider with model: {model}")
            return LocalEmbeddingProvider(model=model)
        
        else:
            logger.warning(f"Unknown embedding provider: {provider_name}, falling back to OpenAI")
            return OpenAIEmbeddingProvider()
    
    async def embed_text(self, text: str) -> List[float]:
        if not text or not text.strip():
            raise ValueError("Text cannot be empty")
        
        return await self.provider.embed_single(text)
    
    async def embed_texts(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        
        valid_texts = [t for t in texts if t and t.strip()]
        if not valid_texts:
            raise ValueError("All texts are empty")
        
        return await self.provider.embed(valid_texts)
    
    async def embed_batch(self, texts: List[str], batch_size: int = 100) -> List[List[float]]:
        if not texts:
            return []
        
        all_embeddings = []
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            embeddings = await self.embed_texts(batch)
            all_embeddings.extend(embeddings)
        
        return all_embeddings

embedding_service = EmbeddingService()
