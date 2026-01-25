"""
Pydantic models for setup configuration schema.
"""

from enum import Enum
from typing import Optional, Dict, Any
from pydantic import BaseModel, Field, field_validator


class SetupMethod(str, Enum):
    """Setup method choice."""

    DOCKER = "docker"
    MANUAL = "manual"


class SupabaseSetupMethod(str, Enum):
    """Supabase setup method choice."""

    CLOUD = "cloud"
    LOCAL = "local"


class MainLLMProvider(str, Enum):
    """Main LLM provider for kortix/basic model."""

    ANTHROPIC = "anthropic"  # Requires ANTHROPIC_API_KEY
    OPENROUTER = "openrouter"  # Requires OPENROUTER_API_KEY (supports grok, openai, minimax via OpenRouter)
    BEDROCK = "bedrock"  # Requires AWS_BEARER_TOKEN_BEDROCK


class SupabaseConfig(BaseModel):
    """Supabase configuration."""

    SUPABASE_URL: str = ""
    SUPABASE_ANON_KEY: str = ""
    SUPABASE_SERVICE_ROLE_KEY: str = ""
    SUPABASE_JWT_SECRET: str = ""
    DATABASE_URL: str = ""
    POSTGRES_PASSWORD: str = ""
    SUPABASE_PROJECT_REF: str = ""
    NEXT_PUBLIC_SUPABASE_URL: str = ""
    EXPO_PUBLIC_SUPABASE_URL: str = ""

    @field_validator("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_URL")
    @classmethod
    def validate_url(cls, v: str) -> str:
        if v and not v.startswith(("http://", "https://")):
            raise ValueError("URL must start with http:// or https://")
        return v

    def is_complete(self) -> bool:
        """Check if all required Supabase fields are configured."""
        return bool(
            self.SUPABASE_URL
            and self.SUPABASE_ANON_KEY
            and self.SUPABASE_SERVICE_ROLE_KEY
            and self.SUPABASE_JWT_SECRET
        )


class DaytonaConfig(BaseModel):
    """Daytona/sandbox configuration."""

    DAYTONA_API_KEY: str = ""
    DAYTONA_SERVER_URL: str = "https://app.daytona.io/api"
    DAYTONA_TARGET: str = "us"

    def is_complete(self) -> bool:
        """Check if Daytona is configured."""
        return bool(self.DAYTONA_API_KEY)


class LLMConfig(BaseModel):
    """LLM provider API keys configuration."""

    # Main LLM provider selection (determines which API key is required)
    # Options: bedrock, anthropic, grok, openai, minimax
    # The setup wizard reads the actual default from backend/core/utils/config.py
    MAIN_LLM: str = ""

    # Optional: Custom model name to override the default for the selected provider
    # Default models per provider:
    #   - anthropic: anthropic/claude-haiku-4-5-20251001
    #   - grok: openrouter/x-ai/grok-4.1-fast (requires OPENROUTER_API_KEY)
    #   - openai: openrouter/openai/gpt-4o-mini (requires OPENROUTER_API_KEY)
    #   - minimax: openrouter/minimax/minimax-m2.1 (requires OPENROUTER_API_KEY)
    MAIN_LLM_MODEL: str = ""

    OPENAI_API_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""
    GROQ_API_KEY: str = ""
    OPENROUTER_API_KEY: str = ""
    XAI_API_KEY: str = ""
    MORPH_API_KEY: str = ""
    GEMINI_API_KEY: str = ""
    OPENAI_COMPATIBLE_API_KEY: str = ""
    OPENAI_COMPATIBLE_API_BASE: str = ""
    AWS_BEARER_TOKEN_BEDROCK: str = ""

    def get_configured_providers(self) -> list[str]:
        """Get list of configured LLM providers."""
        providers = []
        if self.OPENAI_API_KEY:
            providers.append("OpenAI")
        if self.ANTHROPIC_API_KEY:
            providers.append("Anthropic")
        if self.GROQ_API_KEY:
            providers.append("Groq")
        if self.OPENROUTER_API_KEY:
            providers.append("OpenRouter")
        if self.XAI_API_KEY:
            providers.append("xAI")
        if self.MORPH_API_KEY:
            providers.append("Morph")
        if self.GEMINI_API_KEY:
            providers.append("Google Gemini")
        if self.OPENAI_COMPATIBLE_API_KEY:
            providers.append("OpenAI Compatible")
        if self.AWS_BEARER_TOKEN_BEDROCK:
            providers.append("AWS Bedrock")
        return providers

    def has_required_keys(self) -> bool:
        """Check if the required LLM key for the selected main provider is configured."""
        # If no provider selected yet, not complete
        if not self.MAIN_LLM:
            return False
        # Check main LLM provider key
        if self.MAIN_LLM == "anthropic":
            return bool(self.ANTHROPIC_API_KEY)
        elif self.MAIN_LLM in ("grok", "openai", "minimax", "openrouter"):
            # These providers use OpenRouter
            return bool(self.OPENROUTER_API_KEY)
        elif self.MAIN_LLM == "bedrock":
            return bool(self.AWS_BEARER_TOKEN_BEDROCK)
        # Default to checking if any main provider key exists
        return bool(self.ANTHROPIC_API_KEY or self.OPENROUTER_API_KEY or self.AWS_BEARER_TOKEN_BEDROCK)

    def get_required_key_for_provider(self) -> tuple[str, str]:
        """Get the required API key name and env var for the selected main LLM provider."""
        if self.MAIN_LLM == "anthropic":
            return ("Anthropic", "ANTHROPIC_API_KEY")
        elif self.MAIN_LLM == "grok":
            return ("OpenRouter (for Grok)", "OPENROUTER_API_KEY")
        elif self.MAIN_LLM == "openai":
            return ("OpenRouter (for OpenAI)", "OPENROUTER_API_KEY")
        elif self.MAIN_LLM == "minimax":
            return ("OpenRouter (for MiniMax)", "OPENROUTER_API_KEY")
        elif self.MAIN_LLM == "openrouter":
            return ("OpenRouter", "OPENROUTER_API_KEY")
        elif self.MAIN_LLM == "bedrock":
            return ("AWS Bedrock", "AWS_BEARER_TOKEN_BEDROCK")
        return ("Anthropic", "ANTHROPIC_API_KEY")  # default


class SearchConfig(BaseModel):
    """Search and web scraping API keys configuration."""

    TAVILY_API_KEY: str = ""
    FIRECRAWL_API_KEY: str = ""
    FIRECRAWL_URL: str = "https://api.firecrawl.dev"
    SERPER_API_KEY: str = ""
    EXA_API_KEY: str = ""
    SEMANTIC_SCHOLAR_API_KEY: str = ""

    def get_configured_tools(self) -> list[str]:
        """Get list of configured search tools."""
        tools = []
        if self.TAVILY_API_KEY:
            tools.append("Tavily")
        if self.FIRECRAWL_API_KEY:
            tools.append("Firecrawl")
        if self.SERPER_API_KEY:
            tools.append("Serper")
        if self.EXA_API_KEY:
            tools.append("Exa")
        if self.SEMANTIC_SCHOLAR_API_KEY:
            tools.append("Semantic Scholar")
        return tools


class RapidAPIConfig(BaseModel):
    """RapidAPI configuration."""

    RAPID_API_KEY: str = ""


class WebhookConfig(BaseModel):
    """Webhook configuration."""

    WEBHOOK_BASE_URL: str = ""
    TRIGGER_WEBHOOK_SECRET: str = ""
    SUPABASE_WEBHOOK_SECRET: str = ""


class MCPConfig(BaseModel):
    """MCP (Model Context Protocol) configuration."""

    MCP_CREDENTIAL_ENCRYPTION_KEY: str = ""


class ComposioConfig(BaseModel):
    """Composio configuration."""

    COMPOSIO_API_KEY: str = ""
    COMPOSIO_WEBHOOK_SECRET: str = ""

    def is_complete(self) -> bool:
        """Check if Composio is configured."""
        return bool(self.COMPOSIO_API_KEY)


class KortixConfig(BaseModel):
    """Kortix admin configuration."""

    KORTIX_ADMIN_API_KEY: str = ""


class VAPIConfig(BaseModel):
    """VAPI configuration."""

    VAPI_PRIVATE_KEY: str = ""
    VAPI_PHONE_NUMBER_ID: str = ""
    VAPI_SERVER_URL: str = ""


class StripeConfig(BaseModel):
    """Stripe configuration."""

    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""


class LangfuseConfig(BaseModel):
    """Langfuse configuration."""

    LANGFUSE_PUBLIC_KEY: str = ""
    LANGFUSE_SECRET_KEY: str = ""
    LANGFUSE_HOST: str = ""


class BraintrustConfig(BaseModel):
    """Braintrust configuration."""

    BRAINTRUST_API_KEY: str = ""


class MonitoringConfig(BaseModel):
    """Monitoring configuration."""

    SENTRY_DSN: str = ""
    FREESTYLE_API_KEY: str = ""
    CLOUDFLARE_API_TOKEN: str = ""


class FrontendConfig(BaseModel):
    """Frontend-specific configuration."""

    NEXT_PUBLIC_SUPABASE_URL: str = ""
    NEXT_PUBLIC_SUPABASE_ANON_KEY: str = ""
    NEXT_PUBLIC_BACKEND_URL: str = "http://localhost:8000/v1"
    NEXT_PUBLIC_URL: str = "http://localhost:3000"
    NEXT_PUBLIC_ENV_MODE: str = "local"
    NEXT_PUBLIC_POSTHOG_KEY: str = ""
    NEXT_PUBLIC_SENTRY_DSN: str = ""
    NEXT_PUBLIC_PHONE_NUMBER_MANDATORY: str = ""
    NEXT_PUBLIC_APP_URL: str = ""


class MobileConfig(BaseModel):
    """Mobile app configuration."""

    EXPO_PUBLIC_SUPABASE_URL: str = ""
    EXPO_PUBLIC_SUPABASE_ANON_KEY: str = ""
    EXPO_PUBLIC_BACKEND_URL: str = "http://localhost:8000/v1"
    EXPO_PUBLIC_URL: str = "http://localhost:3000"
    EXPO_PUBLIC_ENV_MODE: str = "local"


class SetupConfig(BaseModel):
    """Root configuration model containing all setup categories."""

    setup_method: Optional[SetupMethod] = None
    supabase_setup_method: Optional[SupabaseSetupMethod] = None
    start_method: Optional[str] = None

    supabase: SupabaseConfig = Field(default_factory=SupabaseConfig)
    daytona: DaytonaConfig = Field(default_factory=DaytonaConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    search: SearchConfig = Field(default_factory=SearchConfig)
    rapidapi: RapidAPIConfig = Field(default_factory=RapidAPIConfig)
    webhook: WebhookConfig = Field(default_factory=WebhookConfig)
    mcp: MCPConfig = Field(default_factory=MCPConfig)
    composio: ComposioConfig = Field(default_factory=ComposioConfig)
    kortix: KortixConfig = Field(default_factory=KortixConfig)
    vapi: VAPIConfig = Field(default_factory=VAPIConfig)
    stripe: StripeConfig = Field(default_factory=StripeConfig)
    langfuse: LangfuseConfig = Field(default_factory=LangfuseConfig)
    braintrust: BraintrustConfig = Field(default_factory=BraintrustConfig)
    monitoring: MonitoringConfig = Field(default_factory=MonitoringConfig)
    frontend: FrontendConfig = Field(default_factory=FrontendConfig)
    mobile: MobileConfig = Field(default_factory=MobileConfig)

    def to_flat_dict(self) -> Dict[str, Any]:
        """Convert nested config to flat dictionary for env file generation."""
        flat = {}

        # Add scalar fields
        if self.setup_method:
            flat["setup_method"] = self.setup_method.value
        if self.supabase_setup_method:
            flat["supabase_setup_method"] = self.supabase_setup_method.value

        # Add nested configs
        for section in [
            "supabase",
            "daytona",
            "llm",
            "search",
            "rapidapi",
            "webhook",
            "mcp",
            "composio",
            "kortix",
            "vapi",
            "stripe",
            "langfuse",
            "braintrust",
            "monitoring",
        ]:
            config = getattr(self, section)
            flat.update(config.model_dump())

        return flat

    def is_setup_complete(self) -> bool:
        """Check if the essential setup is complete."""
        return (
            self.supabase.is_complete()
            and self.daytona.is_complete()
            and self.composio.is_complete()
            and self.llm.has_required_keys()
        )

    def get_missing_required(self) -> list[str]:
        """Get list of missing required configurations."""
        missing = []

        if not self.supabase.SUPABASE_URL:
            missing.append("SUPABASE_URL")
        if not self.supabase.SUPABASE_ANON_KEY:
            missing.append("SUPABASE_ANON_KEY")
        if not self.supabase.SUPABASE_SERVICE_ROLE_KEY:
            missing.append("SUPABASE_SERVICE_ROLE_KEY")
        if not self.supabase.SUPABASE_JWT_SECRET:
            missing.append("SUPABASE_JWT_SECRET")
        if not self.daytona.DAYTONA_API_KEY:
            missing.append("DAYTONA_API_KEY")
        if not self.composio.COMPOSIO_API_KEY:
            missing.append("COMPOSIO_API_KEY")

        # Check required LLM key based on MAIN_LLM selection
        if not self.llm.has_required_keys():
            _, required_key = self.llm.get_required_key_for_provider()
            missing.append(required_key)

        return missing


# API Provider information for display purposes
API_PROVIDER_INFO = {
    "ANTHROPIC_API_KEY": {
        "name": "Anthropic Claude",
        "icon": "🤖",
        "url": "https://console.anthropic.com/settings/keys",
        "guide": "1. Go to Anthropic Console → Settings → API Keys\n2. Click 'Create Key'\n3. Copy your API key (starts with 'sk-ant-')",
        "required": False,
    },
    "OPENAI_API_KEY": {
        "name": "OpenAI",
        "icon": "🧠",
        "url": "https://platform.openai.com/api-keys",
        "guide": "1. Go to OpenAI Platform → API Keys\n2. Click 'Create new secret key'\n3. Copy your API key (starts with 'sk-')",
        "required": True,
    },
    "GROQ_API_KEY": {
        "name": "Groq",
        "icon": "⚡",
        "url": "https://console.groq.com/keys",
        "guide": "1. Go to Groq Console → API Keys\n2. Click 'Create API Key'\n3. Copy your API key",
        "required": False,
    },
    "OPENROUTER_API_KEY": {
        "name": "OpenRouter",
        "icon": "🌐",
        "url": "https://openrouter.ai/keys",
        "guide": "1. Go to OpenRouter → Keys\n2. Click 'Create Key'\n3. Copy your API key",
        "required": False,
    },
    "XAI_API_KEY": {
        "name": "xAI",
        "icon": "🚀",
        "url": "https://console.x.ai/",
        "guide": "1. Go to xAI Console\n2. Navigate to API Keys\n3. Create and copy your API key",
        "required": False,
    },
    "GEMINI_API_KEY": {
        "name": "Google Gemini",
        "icon": "💎",
        "url": "https://makersuite.google.com/app/apikey",
        "guide": "1. Go to Google AI Studio → Get API Key\n2. Create API key in Google Cloud Console\n3. Copy your API key",
        "required": False,
    },
    "MORPH_API_KEY": {
        "name": "Morph",
        "icon": "✨",
        "url": "https://morphllm.com/api-keys",
        "guide": "1. Go to Morph → API Keys\n2. Sign up or log in\n3. Create and copy your API key",
        "required": False,
    },
    "AWS_BEARER_TOKEN_BEDROCK": {
        "name": "AWS Bedrock",
        "icon": "☁️",
        "url": "https://console.aws.amazon.com/bedrock",
        "guide": "1. Go to AWS Console → Bedrock\n2. Configure model access in your region\n3. Create IAM credentials with Bedrock access\n4. Use AWS CLI to generate a bearer token",
        "required": False,
    },
    "TAVILY_API_KEY": {
        "name": "Tavily",
        "icon": "🔍",
        "url": "https://tavily.com",
        "guide": "1. Go to Tavily.com → Sign up\n2. Navigate to API Keys\n3. Copy your API key",
        "required": False,
    },
    "FIRECRAWL_API_KEY": {
        "name": "Firecrawl",
        "icon": "🔥",
        "url": "https://firecrawl.dev",
        "guide": "1. Go to Firecrawl.dev → Sign up\n2. Navigate to API Keys\n3. Copy your API key",
        "required": False,
    },
    "SERPER_API_KEY": {
        "name": "Serper",
        "icon": "🖼️",
        "url": "https://serper.dev",
        "guide": "1. Go to Serper.dev → Sign up\n2. Navigate to API Keys\n3. Copy your API key",
        "required": False,
    },
    "EXA_API_KEY": {
        "name": "Exa",
        "icon": "👥",
        "url": "https://exa.ai",
        "guide": "1. Go to Exa.ai → Sign up\n2. Navigate to API Keys\n3. Copy your API key",
        "required": False,
    },
    "SEMANTIC_SCHOLAR_API_KEY": {
        "name": "Semantic Scholar",
        "icon": "📚",
        "url": "https://www.semanticscholar.org/product/api",
        "guide": "1. Go to Semantic Scholar → API\n2. Sign up for API access\n3. Copy your API key",
        "required": False,
    },
    "RAPID_API_KEY": {
        "name": "RapidAPI",
        "icon": "⚡",
        "url": "https://rapidapi.com/developer/security",
        "guide": "1. Go to RapidAPI → Developer Dashboard\n2. Navigate to Security → API Key\n3. Copy your API key",
        "required": False,
    },
    "COMPOSIO_API_KEY": {
        "name": "Composio",
        "icon": "🔗",
        "url": "https://app.composio.dev/settings/api-keys",
        "guide": "1. Go to Composio → Settings → API Keys\n2. Click 'Create API Key'\n3. Copy your API key",
        "required": True,
    },
    "DAYTONA_API_KEY": {
        "name": "Daytona",
        "icon": "🖥️",
        "url": "https://app.daytona.io/keys",
        "guide": "1. Go to Daytona → Keys menu\n2. Generate a new API key\n3. Copy your API key",
        "required": True,
    },
}
