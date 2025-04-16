import os
import requests
from typing import Dict, Any, Optional, TypedDict, Literal


class EndpointSchema(TypedDict):
    route: str
    method: Literal['GET', 'POST']
    name: str
    description: str
    payload: Dict[str, Any]


class RapidDataProviderBase:
    def __init__(self, base_url: str, endpoints: Dict[str, EndpointSchema]):
        self.base_url = base_url
        self.endpoints = endpoints
    
    def get_endpoints(self):
        return self.endpoints
    
    def call_endpoint(
            self,
            route: str,
            payload: Optional[Dict[str, Any]] = None
    ):
        """
        Call an API endpoint with the given parameters and data.
        
        Args:
            endpoint (EndpointSchema): The endpoint configuration dictionary
            params (dict, optional): Query parameters for GET requests
            payload (dict, optional): JSON payload for POST requests
            
        Returns:
            dict: The JSON response from the API
        """
        if route.startswith("/"):
            route = route[1:]

        endpoint = self.endpoints.get(route)
        if not endpoint:
            raise ValueError(f"Endpoint {route} not found")
        
        url = f"{self.base_url}{endpoint['route']}"
        
        headers = {
            "x-rapidapi-key": os.getenv("RAPID_API_KEY"),
            "x-rapidapi-host": url.split("//")[1].split("/")[0],
            "Content-Type": "application/json"
        }

        method = endpoint.get('method', 'GET').upper()
        
        if method == 'GET':
            response = requests.get(url, params=payload, headers=headers)
        elif method == 'POST':
            response = requests.post(url, json=payload, headers=headers)
        else:
            raise ValueError(f"Unsupported HTTP method: {method}")
        return response.json()
