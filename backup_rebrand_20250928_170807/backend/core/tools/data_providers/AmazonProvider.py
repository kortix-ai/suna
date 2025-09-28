from typing import Dict

from core.tools.data_providers.RapidDataProviderBase import RapidDataProviderBase, EndpointSchema


class AmazonProvider(RapidDataProviderBase):
    def __init__(self):
        endpoints: Dict[str, EndpointSchema] = {
            "search": {
                "route": "/search",
                "method": "GET",
                "name": "Amazon Product Search",
                "description": "Search for products on Amazon with various filters and parameters.",
                "payload": {
                    "query": "Search query (supports both free-form text queries or a product asin)",
                    "page": "Results page to return (default: 1)",
                    "country": "Sets the Amazon domain, marketplace country, language and currency (default: US)",
                    "sort_by": "Return the results in a specific sort order (RELEVANCE, LOWEST_PRICE, HIGHEST_PRICE, REVIEWS, NEWEST, BEST_SELLERS)",
                    "product_condition": "Return products in a specific condition (ALL, NEW, USED, RENEWED, COLLECTIBLE)",
                    "is_prime": "Only return prime products (boolean)",
                    "deals_and_discounts": "Return deals and discounts in a specific condition (NONE, ALL_DISCOUNTS, TODAYS_DEALS)",
                    "category_id": "Find products in a specific category / department (optional)",
                    "category": "Filter by specific numeric Amazon category (optional)",
                    "min_price": "Only return product offers with price greater than a certain value (optional)",
                    "max_price": "Only return product offers with price lower than a certain value (optional)",
                    "brand": "Find products with a specific brand (optional)",
                    "seller_id": "Find products sold by specific seller (optional)",
                    "four_stars_and_up": "Return product listings with ratings of 4 stars & up (optional)",
                    "additional_filters": "Any filters available on the Amazon page but not part of this endpoint's parameters (optional)"
                }
            },
            "product-details": {
                "route": "/product-details",
                "method": "GET",
                "name": "Amazon Product Details",
                "description": "Get detailed information about specific Amazon products by ASIN.",
                "payload": {
                    "asin": "Product ASIN for which to get details. Supports batching of up to 10 ASINs in a single request, separated by comma.",
                    "country": "Sets the Amazon domain, marketplace country, language and currency (default: US)",
                    "more_info_query": "A query to search and get more info about the product as part of Product Information, Customer Q&As, and Customer Reviews (optional)",
                    "fields": "A comma separated list of product fields to include in the response (field projection). By default all fields are returned. (optional)"
                }
            },
            "products-by-category": {
                "route": "/products-by-category",
                "method": "GET",
                "name": "Amazon Products by Category",
                "description": "Get products from a specific Amazon category.",
                "payload": {
                    "category_id": "The Amazon category for which to return results. Multiple category values can be separated by comma.",
                    "page": "Page to return (default: 1)",
                    "country": "Sets the Amazon domain, marketplace country, language and currency (default: US)",
                    "sort_by": "Return the results in a specific sort order (RELEVANCE, LOWEST_PRICE, HIGHEST_PRICE, REVIEWS, NEWEST, BEST_SELLERS)",
                    "min_price": "Only return product offers with price greater than a certain value (optional)",
                    "max_price": "Only return product offers with price lower than a certain value (optional)",
                    "product_condition": "Return products in a specific condition (ALL, NEW, USED, RENEWED, COLLECTIBLE)",
                    "brand": "Only return products of a specific brand. Multiple brands can be specified as a comma separated list (optional)",
                    "is_prime": "Only return prime products (boolean)",
                    "deals_and_discounts": "Return deals and discounts in a specific condition (NONE, ALL_DISCOUNTS, TODAYS_DEALS)",
                    "four_stars_and_up": "Return product listings with ratings of 4 stars & up (optional)",
                    "additional_filters": "Any filters available on the Amazon page but not part of this endpoint's parameters (optional)"
                }
            },
            "product-reviews": {
                "route": "/product-reviews",
                "method": "GET",
                "name": "Amazon Product Reviews",
                "description": "Get customer reviews for a specific Amazon product by ASIN.",
                "payload": {
                    "asin": "Product asin for which to get reviews.",
                    "country": "Sets the Amazon domain, marketplace country, language and currency (default: US)",
                    "page": "Results page to return (default: 1)",
                    "sort_by": "Return reviews in a specific sort order (TOP_REVIEWS, MOST_RECENT)",
                    "star_rating": "Only return reviews with a specific star rating (ALL, 5_STARS, 4_STARS, 3_STARS, 2_STARS, 1_STARS, POSITIVE, CRITICAL)",
                    "verified_purchases_only": "Only return reviews by reviewers who made a verified purchase (boolean)",
                    "images_or_videos_only": "Only return reviews containing images and / or videos (boolean)",
                    "current_format_only": "Only return reviews of the current format (product variant - e.g. Color) (boolean)"
                }
            },
            "seller-profile": {
                "route": "/seller-profile",
                "method": "GET",
                "name": "Amazon Seller Profile",
                "description": "Get detailed information about a specific Amazon seller by Seller ID.",
                "payload": {
                    "seller_id": "The Amazon Seller ID for which to get seller profile details",
                    "country": "Sets the Amazon domain, marketplace country, language and currency (default: US)",
                    "fields": "A comma separated list of seller profile fields to include in the response (field projection). By default all fields are returned. (optional)"
                }
            },
            "seller-reviews": {
                "route": "/seller-reviews",
                "method": "GET",
                "name": "Amazon Seller Reviews",
                "description": "Get customer reviews for a specific Amazon seller by Seller ID.",
                "payload": {
                    "seller_id": "The Amazon Seller ID for which to get seller reviews",
                    "country": "Sets the Amazon domain, marketplace country, language and currency (default: US)",
                    "star_rating": "Only return reviews with a specific star rating or positive / negative sentiment (ALL, 5_STARS, 4_STARS, 3_STARS, 2_STARS, 1_STARS, POSITIVE, CRITICAL)",
                    "page": "The page of seller feedback results to retrieve (default: 1)",
                    "fields": "A comma separated list of seller review fields to include in the response (field projection). By default all fields are returned. (optional)"
                }
            }
        }
        base_url = "https://real-time-amazon-data.p.rapidapi.com"
        super().__init__(base_url, endpoints)


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    tool = AmazonProvider()

    # Example for product search
    search_result = tool.call_endpoint(
        route="search",
        payload={
            "query": "Phone",
            "page": 1,
            "country": "US",
            "sort_by": "RELEVANCE",
            "product_condition": "ALL",
            "is_prime": False,
            "deals_and_discounts": "NONE"
        }
    )
    print("Search Result:", search_result)
    
    # Example for product details
    details_result = tool.call_endpoint(
        route="product-details",
        payload={
            "asin": "B07ZPKBL9V",
            "country": "US"
        }
    )
    print("Product Details:", details_result)
    
    # Example for products by category
    category_result = tool.call_endpoint(
        route="products-by-category",
        payload={
            "category_id": "2478868012",
            "page": 1,
            "country": "US",
            "sort_by": "RELEVANCE",
            "product_condition": "ALL",
            "is_prime": False,
            "deals_and_discounts": "NONE"
        }
    )
    print("Category Products:", category_result)
    
    # Example for product reviews
    reviews_result = tool.call_endpoint(
        route="product-reviews",
        payload={
            "asin": "B07ZPKN6YR",
            "country": "US",
            "page": 1,
            "sort_by": "TOP_REVIEWS",
            "star_rating": "ALL",
            "verified_purchases_only": False,
            "images_or_videos_only": False,
            "current_format_only": False
        }
    )
    print("Product Reviews:", reviews_result)
    
    # Example for seller profile
    seller_result = tool.call_endpoint(
        route="seller-profile",
        payload={
            "seller_id": "A02211013Q5HP3OMSZC7W",
            "country": "US"
        }
    )
    print("Seller Profile:", seller_result)
    
    # Example for seller reviews
    seller_reviews_result = tool.call_endpoint(
        route="seller-reviews",
        payload={
            "seller_id": "A02211013Q5HP3OMSZC7W",
            "country": "US",
            "star_rating": "ALL",
            "page": 1
        }
    )
    print("Seller Reviews:", seller_reviews_result)

