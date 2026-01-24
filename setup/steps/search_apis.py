"""
Step 7: Search API Keys (Optional)
"""

from setup.steps.base import BaseStep, StepResult
from setup.config.schema import API_PROVIDER_INFO
from setup.validators.api_keys import validate_api_key


class SearchAPIsStep(BaseStep):
    """Collect API keys for search and web scraping tools."""

    name = "search_apis"
    display_name = "Search API Keys (Optional)"
    order = 7
    required = False
    depends_on = ["requirements"]

    def run(self) -> StepResult:
        # Check if we already have values configured
        has_existing = any([
            self.config.search.TAVILY_API_KEY,
            self.config.search.FIRECRAWL_API_KEY,
            self.config.search.SERPER_API_KEY,
            self.config.search.EXA_API_KEY,
            self.config.search.SEMANTIC_SCHOLAR_API_KEY,
        ])

        if has_existing:
            self.info(
                "Found existing search API keys. Press Enter to keep current values or type new ones."
            )
        else:
            self.info(
                "Search APIs are OPTIONAL tools that enhance Kortix Suna's capabilities."
            )
            self.info(
                "Without these, Kortix Suna will work but won't have web search or scraping functionality."
            )
            self.console.print("\nAvailable Search Tools:")
            self.console.print("  🔍 Tavily - Web search")
            self.console.print("  🔥 Firecrawl - Web scraping")
            self.console.print("  🖼️ Serper - Image search (optional)")
            self.console.print("  👥 Exa - People/company search (optional)")
            self.console.print("  📚 Semantic Scholar - Academic papers (optional)")
            self.console.print("\nPress Enter to skip any optional keys.")

        # Tavily API key
        self._collect_key(
            "TAVILY_API_KEY",
            "Tavily",
            "search",
            "TAVILY_API_KEY",
            required=False,
        )

        # Firecrawl API key
        self._collect_key(
            "FIRECRAWL_API_KEY",
            "Firecrawl",
            "search",
            "FIRECRAWL_API_KEY",
            required=False,
        )

        # Serper API key (optional)
        self.info("Serper enables image search functionality. Leave blank to skip.")
        self._collect_key(
            "SERPER_API_KEY",
            "Serper",
            "search",
            "SERPER_API_KEY",
            required=False,
        )

        # Exa API key (optional)
        self.info("Exa enables advanced people search with LinkedIn/email enrichment. Leave blank to skip.")
        self._collect_key(
            "EXA_API_KEY",
            "Exa",
            "search",
            "EXA_API_KEY",
            required=False,
        )

        # Semantic Scholar API key (optional)
        self.info("Semantic Scholar enables searching and analyzing academic papers. Leave blank to skip.")
        self._collect_key(
            "SEMANTIC_SCHOLAR_API_KEY",
            "Semantic Scholar",
            "search",
            "SEMANTIC_SCHOLAR_API_KEY",
            required=False,
        )

        # Set Firecrawl URL default
        self.config.search.FIRECRAWL_URL = "https://api.firecrawl.dev"

        # Show summary
        self._show_summary()

        return StepResult.ok(
            "Search APIs configured",
            {"search": self.config.search.model_dump()},
        )

    def _collect_key(
        self,
        env_key: str,
        name: str,
        config_section: str,
        config_attr: str,
        required: bool = False,
    ) -> None:
        """Collect an API key."""
        provider_info = API_PROVIDER_INFO.get(env_key, {})
        existing_value = getattr(self.config.search, config_attr, "")

        self.console.print_api_key_prompt(
            provider_info.get("name", name),
            provider_info.get("icon", "🔑"),
            provider_info.get("url", ""),
            provider_info.get("guide", ""),
            optional=not required,
            existing_value=existing_value,
        )

        value = self.ask(
            f"Enter your {name} API key" + ("" if required else " (optional)"),
            validator=lambda x: validate_api_key(x, allow_empty=not required),
            default=existing_value,
            allow_empty=not required,
        )

        setattr(self.config.search, config_attr, value)

    def _show_summary(self) -> None:
        """Show summary of configured search tools."""
        configured = []

        if self.config.search.TAVILY_API_KEY:
            configured.append("Tavily (web search)")
        if self.config.search.FIRECRAWL_API_KEY:
            configured.append("Firecrawl (web scraping)")
        if self.config.search.SERPER_API_KEY:
            configured.append("Serper (image search)")
        if self.config.search.EXA_API_KEY:
            configured.append("Exa (people/company search)")
        if self.config.search.SEMANTIC_SCHOLAR_API_KEY:
            configured.append("Semantic Scholar (academic papers)")

        if configured:
            self.success(f"Search tools configured: {', '.join(configured)}")
        else:
            self.info(
                "No search tools configured - Kortix Suna will work without web search capabilities."
            )

        self.success("Search and scraping keys saved.")

    def get_config_keys(self):
        return [
            "TAVILY_API_KEY",
            "FIRECRAWL_API_KEY",
            "SERPER_API_KEY",
            "EXA_API_KEY",
            "SEMANTIC_SCHOLAR_API_KEY",
        ]
