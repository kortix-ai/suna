# Master model configuration - single source of truth
MODELS = {
    # Free tier models

    "anthropic/claude-sonnet-4-20250514": {
        "aliases": ["claude-sonnet-4"],
        "pricing": {
            "input_cost_per_million_tokens": 3.00,
            "output_cost_per_million_tokens": 15.00
        },
        "tier_availability": ["free", "paid"]
    },
    # "openrouter/deepseek/deepseek-chat": {
    #     "aliases": ["deepseek"],
    #     "pricing": {
    #         "input_cost_per_million_tokens": 0.38,
    #         "output_cost_per_million_tokens": 0.89
    #     },
    #     "tier_availability": ["free", "paid"]
    # },
    # "openrouter/qwen/qwen3-235b-a22b": {
    #     "aliases": ["qwen3"],
    #     "pricing": {
    #         "input_cost_per_million_tokens": 0.13,
    #         "output_cost_per_million_tokens": 0.60
    #     },
    #     "tier_availability": ["free", "paid"]
    # },
    # "openrouter/google/gemini-2.5-flash-preview-05-20": {
    #     "aliases": ["gemini-flash-2.5"],
    #     "pricing": {
    #         "input_cost_per_million_tokens": 0.15,
    #         "output_cost_per_million_tokens": 0.60
    #     },
    #     "tier_availability": ["free", "paid"]
    # },
    # "openrouter/deepseek/deepseek-chat-v3-0324": {
    #     "aliases": ["deepseek/deepseek-chat-v3-0324"],
    #     "pricing": {
    #         "input_cost_per_million_tokens": 0.38,
    #         "output_cost_per_million_tokens": 0.89
    #     },
    #     "tier_availability": ["free", "paid"]
    # },
    "openrouter/moonshotai/kimi-k2": {
        "aliases": ["moonshotai/kimi-k2"],
        "pricing": {
            "input_cost_per_million_tokens": 1.00,
            "output_cost_per_million_tokens": 3.00
        },
        "tier_availability": ["free", "paid"]
    },
    "xai/grok-4": {
        "aliases": ["grok-4", "x-ai/grok-4"],
        "pricing": {
            "input_cost_per_million_tokens": 5.00,
            "output_cost_per_million_tokens": 15.00
        },
        "tier_availability": ["paid"]
    },
    
    # Paid tier only models
    "gemini/gemini-2.5-pro": {
        "aliases": ["google/gemini-2.5-pro"],
        "pricing": {
            "input_cost_per_million_tokens": 1.25,
            "output_cost_per_million_tokens": 10.00
        },
        "tier_availability": ["paid"]
    },
    "openai/gpt-4o": {
        "aliases": ["gpt-4o"],
        "pricing": {
            "input_cost_per_million_tokens": 2.50,
            "output_cost_per_million_tokens": 10.00
        },
        "tier_availability": ["paid"]
    },
    "openai/gpt-4.1": {
        "aliases": ["gpt-4.1"],
        "pricing": {
            "input_cost_per_million_tokens": 15.00,
            "output_cost_per_million_tokens": 60.00
        },
        "tier_availability": ["paid"]
    },
    "openai/gpt-4.1-mini": {
        "aliases": ["gpt-4.1-mini"],
        "pricing": {
            "input_cost_per_million_tokens": 1.50,
            "output_cost_per_million_tokens": 6.00
        },
        "tier_availability": ["paid"]
    },
    "anthropic/claude-3-7-sonnet-latest": {
        "aliases": ["sonnet-3.7"],
        "pricing": {
            "input_cost_per_million_tokens": 3.00,
            "output_cost_per_million_tokens": 15.00
        },
        "tier_availability": ["paid"]
    },
    "anthropic/claude-3-5-sonnet-latest": {
        "aliases": ["sonnet-3.5"],
        "pricing": {
            "input_cost_per_million_tokens": 3.00,
            "output_cost_per_million_tokens": 15.00
        },
        "tier_availability": ["paid"]
    },   
}

# Derived structures (auto-generated from MODELS)
def _generate_model_structures():
    """Generate all model structures from the master MODELS dictionary."""
    
    # Generate tier lists
    free_models = []
    paid_models = []
    
    # Generate aliases
    aliases = {}
    
    # Generate pricing
    pricing = {}
    
    for model_name, config in MODELS.items():
        # Add to tier lists
        if "free" in config["tier_availability"]:
            free_models.append(model_name)
        if "paid" in config["tier_availability"]:
            paid_models.append(model_name)
        
        # Add aliases
        for alias in config["aliases"]:
            aliases[alias] = model_name
        
        # Add pricing
        pricing[model_name] = config["pricing"]
        
        # Also add pricing for legacy model name variations
        if model_name.startswith("openrouter/deepseek/"):
            legacy_name = model_name.replace("openrouter/", "")
            pricing[legacy_name] = config["pricing"]
        elif model_name.startswith("openrouter/qwen/"):
            legacy_name = model_name.replace("openrouter/", "")
            pricing[legacy_name] = config["pricing"]
        elif model_name.startswith("gemini/"):
            legacy_name = model_name.replace("gemini/", "")
            pricing[legacy_name] = config["pricing"]
        elif model_name.startswith("anthropic/"):
            # Add anthropic/claude-sonnet-4 alias for claude-sonnet-4-20250514
            if "claude-sonnet-4-20250514" in model_name:
                pricing["anthropic/claude-sonnet-4"] = config["pricing"]
        elif model_name.startswith("xai/"):
            # Add pricing for OpenRouter x-ai models
            openrouter_name = model_name.replace("xai/", "openrouter/x-ai/")
            pricing[openrouter_name] = config["pricing"]
    
    return free_models, paid_models, aliases, pricing

# Generate all structures
FREE_TIER_MODELS, PAID_TIER_MODELS, MODEL_NAME_ALIASES, HARDCODED_MODEL_PRICES = _generate_model_structures()

MODEL_ACCESS_TIERS = {
    "free": FREE_TIER_MODELS,
    "tier_2_20": PAID_TIER_MODELS,
    "tier_6_50": PAID_TIER_MODELS,
    "tier_12_100": PAID_TIER_MODELS,
    "tier_25_200": PAID_TIER_MODELS,
    "tier_50_400": PAID_TIER_MODELS,
    "tier_125_800": PAID_TIER_MODELS,
    "tier_200_1000": PAID_TIER_MODELS,
}
