"""
Configuration management.

This module provides a centralized way to access configuration settings and
environment variables across the application. It supports different environment
modes (development, staging, production) and provides validation for required
values.

Usage:
    from utils.config import config
    
    # Access configuration values
    api_key = config.OPENAI_API_KEY
    env_mode = config.ENV_MODE
"""

import os
from enum import Enum
from typing import Dict, Any, Optional, get_type_hints, Union
from dotenv import load_dotenv
import logging

logger = logging.getLogger(__name__)

class EnvMode(Enum):
    """Environment mode enumeration."""
    LOCAL = "local"
    STAGING = "staging"
    PRODUCTION = "production"

class Configuration:
    """
    Centralized configuration for AgentPress backend.
    
    This class loads environment variables and provides type checking and validation.
    Default values can be specified for optional configuration items.
    """
    
    # Environment mode
    ENV_MODE: EnvMode = EnvMode.LOCAL
    
    # Subscription tier IDs - Production
    STRIPE_FREE_TIER_ID_PROD: str = 'price_1RILb4G6l1KZGqIrK4QLrx9i'
    STRIPE_TIER_2_20_ID_PROD: str = 'price_1RILb4G6l1KZGqIrhomjgDnO'
    STRIPE_TIER_6_50_ID_PROD: str = 'price_1RILb4G6l1KZGqIr5q0sybWn'
    STRIPE_TIER_12_100_ID_PROD: str = 'price_1RILb4G6l1KZGqIr5Y20ZLHm'
    STRIPE_TIER_25_200_ID_PROD: str = 'price_1RILb4G6l1KZGqIrGAD8rNjb'
    STRIPE_TIER_50_400_ID_PROD: str = 'price_1RILb4G6l1KZGqIruNBUMTF1'
    STRIPE_TIER_125_800_ID_PROD: str = 'price_1RILb3G6l1KZGqIrbJA766tN'
    STRIPE_TIER_200_1000_ID_PROD: str = 'price_1RILb3G6l1KZGqIrmauYPOiN'
    
    # Subscription tier IDs - Staging
    STRIPE_FREE_TIER_ID_STAGING: str = 'price_1RIGvuG6l1KZGqIrw14abxeL'
    STRIPE_TIER_2_20_ID_STAGING: str = 'price_1RIGvuG6l1KZGqIrCRu0E4Gi'
    STRIPE_TIER_6_50_ID_STAGING: str = 'price_1RIGvuG6l1KZGqIrvjlz5p5V'
    STRIPE_TIER_12_100_ID_STAGING: str = 'price_1RIGvuG6l1KZGqIrT6UfgblC'
    STRIPE_TIER_25_200_ID_STAGING: str = 'price_1RIGvuG6l1KZGqIrOVLKlOMj'
    STRIPE_TIER_50_400_ID_STAGING: str = 'price_1RIKNgG6l1KZGqIrvsat5PW7'
    STRIPE_TIER_125_800_ID_STAGING: str = 'price_1RIKNrG6l1KZGqIrjKT0yGvI'
    STRIPE_TIER_200_1000_ID_STAGING: str = 'price_1RIKQ2G6l1KZGqIrum9n8SI7'
    
    # Computed subscription tier IDs based on environment
    @property
    def STRIPE_FREE_TIER_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_FREE_TIER_ID_STAGING
        return self.STRIPE_FREE_TIER_ID_PROD
    
    @property
    def STRIPE_TIER_2_20_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_2_20_ID_STAGING
        return self.STRIPE_TIER_2_20_ID_PROD
    
    @property
    def STRIPE_TIER_6_50_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_6_50_ID_STAGING
        return self.STRIPE_TIER_6_50_ID_PROD
    
    @property
    def STRIPE_TIER_12_100_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_12_100_ID_STAGING
        return self.STRIPE_TIER_12_100_ID_PROD
    
    @property
    def STRIPE_TIER_25_200_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_25_200_ID_STAGING
        return self.STRIPE_TIER_25_200_ID_PROD
    
    @property
    def STRIPE_TIER_50_400_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_50_400_ID_STAGING
        return self.STRIPE_TIER_50_400_ID_PROD
    
    @property
    def STRIPE_TIER_125_800_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_125_800_ID_STAGING
        return self.STRIPE_TIER_125_800_ID_PROD
    
    @property
    def STRIPE_TIER_200_1000_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_TIER_200_1000_ID_STAGING
        return self.STRIPE_TIER_200_1000_ID_PROD
    
    # LLM API keys
    ANTHROPIC_API_KEY: str = None
    OPENAI_API_KEY: Optional[str] = None
    GROQ_API_KEY: Optional[str] = None
    OPENROUTER_API_KEY: Optional[str] = None
    OPENROUTER_API_BASE: Optional[str] = "https://openrouter.ai/api/v1"
    OR_SITE_URL: Optional[str] = "https://kortix.ai"
    OR_APP_NAME: Optional[str] = "Kortix AI"    
    
    # AWS Bedrock credentials
    AWS_ACCESS_KEY_ID: Optional[str] = None
    AWS_SECRET_ACCESS_KEY: Optional[str] = None
    AWS_REGION_NAME: Optional[str] = None
    
    # Model configuration
    MODEL_TO_USE: Optional[str] = "anthropic/claude-3-7-sonnet-latest"
    
    # Supabase configuration
    SUPABASE_URL: str
    SUPABASE_ANON_KEY: str
    SUPABASE_SERVICE_ROLE_KEY: str
    
    # Redis configuration
    REDIS_HOST: str
    REDIS_PORT: int = 6379
    REDIS_PASSWORD: Optional[str] = None
    REDIS_SSL: bool = True
    
    # Daytona sandbox configuration
    DAYTONA_API_KEY: str
    DAYTONA_SERVER_URL: str
    DAYTONA_TARGET: str
    
    # Search and other API keys
    TAVILY_API_KEY: str
    RAPID_API_KEY: str
    CLOUDFLARE_API_TOKEN: Optional[str] = None
    FIRECRAWL_API_KEY: str
    FIRECRAWL_URL: Optional[str] = "https://api.firecrawl.dev"
    
    # Stripe configuration
    STRIPE_SECRET_KEY: Optional[str] = None
    STRIPE_WEBHOOK_SECRET: Optional[str] = None
    STRIPE_DEFAULT_PLAN_ID: Optional[str] = None
    STRIPE_DEFAULT_TRIAL_DAYS: int = 14
    
    # Stripe Product IDs
    STRIPE_PRODUCT_ID_PROD: str = 'prod_SCl7AQ2C8kK1CD'
    STRIPE_PRODUCT_ID_STAGING: str = 'prod_SCgIj3G7yPOAWY'
    
    # Sandbox configuration
    SANDBOX_IMAGE_NAME = "kortix/suna:0.1.3"
    SANDBOX_ENTRYPOINT = "/usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf"

    # LangFuse configuration
    LANGFUSE_PUBLIC_KEY: Optional[str] = None
    LANGFUSE_SECRET_KEY: Optional[str] = None
    LANGFUSE_HOST: str = "https://cloud.langfuse.com"

    @property
    def STRIPE_PRODUCT_ID(self) -> str:
        if self.ENV_MODE == EnvMode.STAGING:
            return self.STRIPE_PRODUCT_ID_STAGING
        return self.STRIPE_PRODUCT_ID_PROD
    
    def __init__(self):
        """Initialize configuration by loading from environment variables."""
        # Load environment variables from .env file if it exists
        load_dotenv()
        
        # Set environment mode first
        env_mode_str = os.getenv("ENV_MODE", EnvMode.LOCAL.value)
        try:
            self.ENV_MODE = EnvMode(env_mode_str.lower())
        except ValueError:
            logger.warning(f"Invalid ENV_MODE: {env_mode_str}, defaulting to LOCAL")
            self.ENV_MODE = EnvMode.LOCAL
            
        logger.info(f"Environment mode: {self.ENV_MODE.value}")
        
        # Load configuration from environment variables
        self._load_from_env()
        
        # Perform validation
        self._validate()
        
    def _load_from_env(self):
        """Load configuration values from environment variables."""
        for key, expected_type in get_type_hints(self.__class__).items():
            env_val = os.getenv(key)
            
            if env_val is not None:
                # Convert environment variable to the expected type
                if expected_type == bool:
                    # Handle boolean conversion
                    setattr(self, key, env_val.lower() in ('true', 't', 'yes', 'y', '1'))
                elif expected_type == int:
                    # Handle integer conversion
                    try:
                        setattr(self, key, int(env_val))
                    except ValueError:
                        logger.warning(f"Invalid value for {key}: {env_val}, using default")
                elif expected_type == EnvMode:
                    # Already handled for ENV_MODE
                    pass
                else:
                    # String or other type
                    setattr(self, key, env_val)
    
    def _validate(self):
        """Validate configuration based on type hints."""
        # Get all configuration fields and their type hints
        type_hints = get_type_hints(self.__class__)
        
        # Find missing required fields
        missing_fields = []
        for field, field_type in type_hints.items():
            # Check if the field is Optional
            is_optional = hasattr(field_type, "__origin__") and field_type.__origin__ is Union and type(None) in field_type.__args__
            
            # If not optional and value is None, add to missing fields
            if not is_optional and getattr(self, field) is None:
                missing_fields.append(field)
        
        if missing_fields:
            error_msg = f"Missing required configuration fields: {', '.join(missing_fields)}"
            logger.error(error_msg)
            raise ValueError(error_msg)
    
    def get(self, key: str, default: Any = None) -> Any:
        """Get a configuration value with an optional default."""
        return getattr(self, key, default)
    
    def as_dict(self) -> Dict[str, Any]:
        """Return configuration as a dictionary."""
        return {
            key: getattr(self, key) 
            for key in get_type_hints(self.__class__).keys()
            if not key.startswith('_')
        }

# Create a singleton instance
config = Configuration() 