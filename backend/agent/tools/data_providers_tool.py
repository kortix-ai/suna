import json

from agentpress.tool import Tool, ToolResult, openapi_schema, xml_schema
from agent.tools.data_providers.LinkedinProvider import LinkedinProvider
from agent.tools.data_providers.YahooFinanceProvider import YahooFinanceProvider
from agent.tools.data_providers.AmazonProvider import AmazonProvider
from agent.tools.data_providers.ZillowProvider import ZillowProvider
from agent.tools.data_providers.TwitterProvider import TwitterProvider

class DataProvidersTool(Tool):
    """Tool for making requests to various data providers."""

    def __init__(self):
        super().__init__()

        self.register_data_providers = {
            "linkedin": LinkedinProvider(),
            "yahoo_finance": YahooFinanceProvider(),
            "amazon": AmazonProvider(),
            "zillow": ZillowProvider(),
            "twitter": TwitterProvider()
        }

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_data_provider_endpoints",
            "description": "Get available endpoints for a specific data provider",
            "parameters": {
                "type": "object",
                "properties": {
                    "service_name": {
                        "type": "string",
                        "description": "The name of the data provider (e.g., 'linkedin', 'twitter', 'zillow', 'amazon', 'yahoo_finance')"
                    }
                },
                "required": ["service_name"]
            }
        }
    })
    @xml_schema(
        tag_name="get-data-provider-endpoints",
        mappings=[
            {"param_name": "service_name", "node_type": "attribute", "path": "."}
        ],
        example='''
<!-- 
The get-data-provider-endpoints tool returns available endpoints for a specific data provider.
Use this tool when you need to discover what endpoints are available.
-->

<!-- Example to get LinkedIn API endpoints -->
<get-data-provider-endpoints service_name="linkedin">
</get-data-provider-endpoints>
        '''
    )
    async def get_data_provider_endpoints(
        self,
        service_name: str
    ) -> ToolResult:
        """
        Get available endpoints for a specific data provider.
        
        Parameters:
        - service_name: The name of the data provider (e.g., 'linkedin')
        """
        try:
            if not service_name:
                return self.fail_response("Data provider name is required.")
                
            if service_name not in self.register_data_providers:
                return self.fail_response(f"Data provider '{service_name}' not found. Available data providers: {list(self.register_data_providers.keys())}")
                
            endpoints = self.register_data_providers[service_name].get_endpoints()
            return self.success_response(endpoints)
            
        except Exception as e:
            error_message = str(e)
            simplified_message = f"Error getting data provider endpoints: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "execute_data_provider_call",
            "description": "Execute a call to a specific data provider endpoint",
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
        tag_name="execute-data-provider-call",
        mappings=[
            {"param_name": "service_name", "node_type": "attribute", "path": "service_name"},
            {"param_name": "route", "node_type": "attribute", "path": "route"},
            {"param_name": "payload", "node_type": "content", "path": "."}
        ],
        example='''
        <!-- 
        The execute-data-provider-call tool makes a request to a specific data provider endpoint.
        Use this tool when you need to call an data provider endpoint with specific parameters.
        The route must be a valid endpoint key obtained from get-data-provider-endpoints tool!!
        -->
        
        <!-- Example to call linkedIn service with the specific route person -->
        <execute-data-provider-call service_name="linkedin" route="person">
            {"link": "https://www.linkedin.com/in/johndoe/"}
        </execute-data-provider-call>
        '''
    )
    async def execute_data_provider_call(
        self,
        service_name: str,
        route: str,
        payload: str # this actually a json string
    ) -> ToolResult:
        """
        Execute a call to a specific data provider endpoint.
        
        Parameters:
        - service_name: The name of the data provider (e.g., 'linkedin')
        - route: The key of the endpoint to call
        - payload: The payload to send with the data provider call
        """
        try:
            payload = json.loads(payload)

            if not service_name:
                return self.fail_response("service_name is required.")

            if not route:
                return self.fail_response("route is required.")
                
            if service_name not in self.register_data_providers:
                return self.fail_response(f"API '{service_name}' not found. Available APIs: {list(self.register_data_providers.keys())}")
            
            data_provider = self.register_data_providers[service_name]
            if route == service_name:
                return self.fail_response(f"route '{route}' is the same as service_name '{service_name}'. YOU FUCKING IDIOT!")
            
            if route not in data_provider.get_endpoints().keys():
                return self.fail_response(f"Endpoint '{route}' not found in {service_name} data provider.")
            
            
            result = data_provider.call_endpoint(route, payload)
            return self.success_response(result)
            
        except Exception as e:
            error_message = str(e)
            print(error_message)
            simplified_message = f"Error executing data provider call: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)
