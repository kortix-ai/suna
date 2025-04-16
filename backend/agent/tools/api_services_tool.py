import json

from agentpress.tool import Tool, ToolResult, openapi_schema, xml_schema
from agent.tools.api_services.LinkedInService import LinkedInService

class APIServicesTool(Tool):
    """Tool for making requests to various API services."""

    def __init__(self):
        super().__init__()

        self.register_apis = {
            "linkedin": LinkedInService()
        }

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_api_service_endpoints",
            "description": "Get available endpoints for a specific API service",
            "parameters": {
                "type": "object",
                "properties": {
                    "service_name": {
                        "type": "string",
                        "description": "The name of the API service (e.g., 'linkedin')"
                    }
                },
                "required": ["service_name"]
            }
        }
    })
    @xml_schema(
        tag_name="get-api-service-endpoints",
        mappings=[
            {"param_name": "service_name", "node_type": "attribute", "path": "."}
        ],
        example='''
<!-- 
The get-api-service-endpoints tool returns available endpoints for a specific API service.
Use this tool when you need to discover what endpoints are available.
-->

<!-- Example to get LinkedIn API endpoints -->
<get-api-service-endpoints service_name="linkedin">
</get-api-service-endpoints>
        '''
    )
    async def get_api_service_endpoints(
        self,
        service_name: str
    ) -> ToolResult:
        """
        Get available endpoints for a specific API service.
        
        Parameters:
        - service_name: The name of the API service (e.g., 'linkedin')
        """
        try:
            if not service_name:
                return self.fail_response("API name is required.")
                
            if service_name not in self.register_apis:
                return self.fail_response(f"API '{service_name}' not found. Available APIs: {list(self.register_apis.keys())}")
                
            endpoints = self.register_apis[service_name].get_endpoints()
            return self.success_response(endpoints)
            
        except Exception as e:
            error_message = str(e)
            simplified_message = f"Error getting API endpoints: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "execute_api_call",
            "description": "Execute a call to a specific API endpoint",
            "parameters": {
                "type": "object",
                "properties": {
                    "service_name": {
                        "type": "string",
                        "description": "The name of the API service (e.g., 'linkedin')"
                    },
                    "route": {
                        "type": "string",
                        "description": "The key of the endpoint to call"
                    },
                    "payload": {
                        "type": "object",
                        "description": "The payload to send with the API call"
                    }
                },
                "required": ["service_name", "route"]
            }
        }
    })
    @xml_schema(
        tag_name="execute-api-call",
        mappings=[
            {"param_name": "service_name", "node_type": "attribute", "path": "service_name"},
            {"param_name": "route", "node_type": "attribute", "path": "route"},
            {"param_name": "payload", "node_type": "content", "path": "."}
        ],
        example='''
        <!-- 
        The execute-api-call tool makes a request to a specific API endpoint.
        Use this tool when you need to call an API endpoint with specific parameters.
        The route must be a valid endpoint key obtained from get-api-service-endpoints tool!!
        -->
        
        <!-- Example to call linkedIn service with the specific route person -->
        <execute-api-call service_name="linkedin" route="person">
            {"link": "https://www.linkedin.com/in/johndoe/"}
        </execute-api-call>
        '''
    )
    async def execute_api_call(
        self,
        service_name: str,
        route: str,
        payload: str # this actually a json string
    ) -> ToolResult:
        """
        Execute a call to a specific API endpoint.
        
        Parameters:
        - service_name: The name of the API service (e.g., 'linkedin')
        - route: The key of the endpoint to call
        - payload: The payload to send with the API call
        """
        try:
            payload = json.loads(payload)

            if not service_name:
                return self.fail_response("service_name is required.")

            if not route:
                return self.fail_response("route is required.")
                
            if service_name not in self.register_apis:
                return self.fail_response(f"API '{service_name}' not found. Available APIs: {list(self.register_apis.keys())}")
            
            api_service = self.register_apis[service_name]
            if route == service_name:
                return self.fail_response(f"route '{route}' is the same as service_name '{service_name}'. YOU FUCKING IDIOT!")
            
            if route not in api_service.get_endpoints().keys():
                return self.fail_response(f"Endpoint '{route}' not found in {service_name} API.")
            
            
            result = api_service.call_endpoint(route, payload)
            return self.success_response(result)
            
        except Exception as e:
            error_message = str(e)
            print(error_message)
            simplified_message = f"Error executing API call: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)
