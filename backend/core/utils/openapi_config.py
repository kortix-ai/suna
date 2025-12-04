"""
OpenAPI/Swagger configuration for FastAPI documentation.

Configures authentication methods (API Key and Bearer Token) and API documentation.
"""

from fastapi import FastAPI
from fastapi.security import APIKeyHeader
from fastapi.openapi.utils import get_openapi


# Security scheme for API Key header
api_key_header = APIKeyHeader(
    name="X-API-Key",
    auto_error=False,
    description="API Key in format: pk_xxx:sk_xxx"
)


def configure_openapi(app: FastAPI) -> None:
    """
    Configure custom OpenAPI schema with both API Key and Bearer token authentication.
    
    Args:
        app: The FastAPI application instance
    """
    def custom_openapi():
        if app.openapi_schema:
            return app.openapi_schema
        
        openapi_schema = get_openapi(
            title="Kortix API",
            version="1.0.0",
            description="""
## Authentication

This API supports two authentication methods:

### 1. API Key (Recommended for programmatic access)
Use the `X-API-Key` header with your API key in the format: `pk_xxx:sk_xxx`

```bash
curl -H "X-API-Key: pk_abc123:sk_def456" https://api.kortix.com/v1/threads
```

**Get your API key:** [https://www.kortix.com/settings/api-keys](https://www.kortix.com/settings/api-keys)

### 2. Bearer Token (JWT)
Use the `Authorization` header with a Supabase JWT token:

```bash
curl -H "Authorization: Bearer eyJhbG..." https://api.kortix.com/v1/threads
```
            """,
            routes=app.routes,
        )
        
        # Add both security schemes
        openapi_schema["components"]["securitySchemes"] = {
            "APIKeyHeader": {
                "type": "apiKey",
                "in": "header",
                "name": "X-API-Key",
                "description": "API Key in format pk_xxx:sk_xxx — Generate at https://www.kortix.com/settings/api-keys"
            },
            "BearerAuth": {
                "type": "http",
                "scheme": "bearer",
                "bearerFormat": "JWT",
                "description": "Supabase JWT token"
            }
        }
        
        # Apply security globally (both methods accepted)
        openapi_schema["security"] = [
            {"APIKeyHeader": []},
            {"BearerAuth": []}
        ]
        
        app.openapi_schema = openapi_schema
        return app.openapi_schema
    
    app.openapi = custom_openapi
