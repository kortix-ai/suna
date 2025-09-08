from typing import Dict
import logging

from core.tools.data_providers.RapidDataProviderBase import RapidDataProviderBase, EndpointSchema

logger = logging.getLogger(__name__)


class ZillowProvider(RapidDataProviderBase):
    def __init__(self):
        endpoints: Dict[str, EndpointSchema] = {
            "search": {
                "route": "/search",
                "method": "GET",
                "name": "Zillow Property Search",
                "description": "Search for properties by neighborhood, city, or ZIP code with various filters.",
                "payload": {
                    "location": "Location can be an address, neighborhood, city, or ZIP code (required)",
                    "page": "Page number for pagination (optional, default: 0)",
                    "output": "Output format: json, csv, xlsx (optional, default: json)",
                    "status": "Status of properties: forSale, forRent, recentlySold (optional, default: forSale)",
                    "sortSelection": "Sorting criteria (optional, default: priorityscore)",
                    "listing_type": "Listing type: by_agent, by_owner_other (optional, default: by_agent)",
                    "doz": "Days on Zillow: any, 1, 7, 14, 30, 90, 6m, 12m, 24m, 36m (optional, default: any)",
                    "price_min": "Minimum price (optional)",
                    "price_max": "Maximum price (optional)",
                    "sqft_min": "Minimum square footage (optional)",
                    "sqft_max": "Maximum square footage (optional)",
                    "beds_min": "Minimum number of bedrooms (optional)",
                    "beds_max": "Maximum number of bedrooms (optional)",
                    "baths_min": "Minimum number of bathrooms (optional)",
                    "baths_max": "Maximum number of bathrooms (optional)",
                    "built_min": "Minimum year built (optional)",
                    "built_max": "Maximum year built (optional)",
                    "lotSize_min": "Minimum lot size in sqft (optional)",
                    "lotSize_max": "Maximum lot size in sqft (optional)",
                    "keywords": "Keywords to search for (optional)"
                }
            },
            "search_address": {
                "route": "/search_address",
                "method": "GET",
                "name": "Zillow Address Search",
                "description": "Search for a specific property by its full address.",
                "payload": {
                    "address": "Full property address (required)"
                }
            },
            "propertyV2": {
                "route": "/propertyV2",
                "method": "GET",
                "name": "Zillow Property Details",
                "description": "Get detailed information about a specific property by zpid or URL.",
                "payload": {
                    "zpid": "Zillow property ID (optional if URL is provided)",
                    "url": "Property details URL (optional if zpid is provided)"
                }
            },
            "zestimate_history": {
                "route": "/zestimate_history",
                "method": "GET",
                "name": "Zillow Zestimate History",
                "description": "Get historical Zestimate values for a specific property.",
                "payload": {
                    "zpid": "Zillow property ID (optional if URL is provided)",
                    "url": "Property details URL (optional if zpid is provided)"
                }
            },
            "similar_properties": {
                "route": "/similar_properties",
                "method": "GET",
                "name": "Zillow Similar Properties",
                "description": "Find properties similar to a specific property.",
                "payload": {
                    "zpid": "Zillow property ID (optional if URL or address is provided)",
                    "url": "Property details URL (optional if zpid or address is provided)",
                    "address": "Property address (optional if zpid or URL is provided)"
                }
            },
            "mortgage_rates": {
                "route": "/mortgage/rates",
                "method": "GET",
                "name": "Zillow Mortgage Rates",
                "description": "Get current mortgage rates for different loan programs and conditions.",
                "payload": {
                    "program": "Loan program (required): Fixed30Year, Fixed20Year, Fixed15Year, Fixed10Year, ARM3, ARM5, ARM7, etc.",
                    "state": "State abbreviation (optional, default: US)",
                    "refinance": "Whether this is for refinancing (optional, default: false)",
                    "loanType": "Type of loan: Conventional, etc. (optional)",
                    "loanAmount": "Loan amount category: Micro, SmallConforming, Conforming, SuperConforming, Jumbo (optional)",
                    "loanToValue": "Loan to value ratio: Normal, High, VeryHigh (optional)",
                    "creditScore": "Credit score category: Low, High, VeryHigh (optional)",
                    "duration": "Duration in days (optional, default: 30)"
                }
            },
        }
        base_url = "https://zillow56.p.rapidapi.com"
        super().__init__(base_url, endpoints)


if __name__ == "__main__":
    from dotenv import load_dotenv
    from time import sleep
    load_dotenv()
    tool = ZillowProvider()

    # Example for searching properties in Houston
    search_result = tool.call_endpoint(
        route="search",
        payload={
            "location": "houston, tx",
            "status": "forSale",
            "sortSelection": "priorityscore",
            "listing_type": "by_agent",
            "doz": "any"
        }
    )
    logger.debug("Search Result: %s", search_result)
    logger.debug("***")
    logger.debug("***")
    logger.debug("***")
    sleep(1)
    # Example for searching by address
    address_result = tool.call_endpoint(
        route="search_address",
        payload={
            "address": "1161 Natchez Dr College Station Texas 77845"
        }
    )
    logger.debug("Address Search Result: %s", address_result)
    logger.debug("***")
    logger.debug("***")
    logger.debug("***")
    sleep(1)
    # Example for getting property details
    property_result = tool.call_endpoint(
        route="propertyV2",
        payload={
            "zpid": "7594920"
        }
    )
    logger.debug("Property Details Result: %s", property_result)
    sleep(1)
    logger.debug("***")
    logger.debug("***")
    logger.debug("***")

    # Example for getting zestimate history
    zestimate_result = tool.call_endpoint(
        route="zestimate_history",
        payload={
            "zpid": "20476226"
        }
    )
    logger.debug("Zestimate History Result: %s", zestimate_result)
    sleep(1)
    logger.debug("***")
    logger.debug("***")
    logger.debug("***")
    # Example for getting similar properties
    similar_result = tool.call_endpoint(
        route="similar_properties",
        payload={
            "zpid": "28253016"
        }
    )
    logger.debug("Similar Properties Result: %s", similar_result)
    sleep(1)
    logger.debug("***")
    logger.debug("***")
    logger.debug("***")
    # Example for getting mortgage rates
    mortgage_result = tool.call_endpoint(
        route="mortgage_rates",
        payload={
            "program": "Fixed30Year",
            "state": "US",
            "refinance": "false",
            "loanType": "Conventional",
            "loanAmount": "Conforming",
            "loanToValue": "Normal",
            "creditScore": "Low",
            "duration": "30"
        }
    )
    logger.debug("Mortgage Rates Result: %s", mortgage_result)
  