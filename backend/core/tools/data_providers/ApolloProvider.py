from typing import Dict

from agent.tools.data_providers.RapidDataProviderBase import RapidDataProviderBase, EndpointSchema


class ApolloProvider(RapidDataProviderBase):
    def __init__(self):
        endpoints: Dict[str, EndpointSchema] = {
            "search_people": {
                "route": "/search_people",
                "method": "GET",
                "name": "Search People",
                "description": "Search for people/contacts using various filters and criteria.",
                "payload": {
                    "q_person_name": "Person name search query (optional)",
                    "page": "Page number for pagination (required, default: 1)",
                    "not_organization_ids": "IDs of organizations to exclude people from. For multiple IDs, separate with comma (optional)",
                    "organization_ids": "IDs of organizations to get people from. For multiple IDs, separate with comma (optional)",
                    "person_past_organization_ids": "IDs of organizations people used to work in. For multiple IDs, separate with comma (optional)",
                    "person_titles": "Job titles of people you are interested in. For multiple titles, separate with comma (optional)",
                    "person_past_titles": "Past job titles of people you are interested in. For multiple titles, separate with comma (optional)",
                    "person_not_titles": "Job titles of people you are NOT interested in. For multiple titles, separate with comma (optional)",
                    "person_locations": "Locations to filter people. For multiple locations, separate with comma (e.g., 'United States,United Kingdom') (optional)",
                    "zip_code": "ZIP code for location-based search (use with person_location_radius) (optional)",
                    "person_location_radius": "Radius in miles for ZIP code search. Values: 25, 50, 100, 300 (optional)",
                    "organization_num_employees_ranges": "Employee count ranges for current company. Values: 1-10, 1-20, 21-50, 51-100, 101-200, 201-500, 501-1000, 1001-2000, 2001-5000, 5001-10000, 10001 (optional)",
                    "organization_industry_tag_ids": "Industry tag IDs for current company. For multiple values, separate with comma (optional)",
                    "q_organization_keyword_tags": "Keywords to match with current company. For multiple values, separate with comma (optional)",
                    "contact_email_status_v2": "Email verification status. Values: verified, likely_to_engage, unverified, new_data_available, unavailable. For multiple values, separate with comma (optional)"
                }
            },
            "search_people_via_url": {
                "route": "/search_people_via_url",
                "method": "POST",
                "name": "Search People Via URL",
                "description": "Search for people using a pre-built Apollo.io URL with filters.",
                "payload": {
                    "url": "Apollo.io people search URL with pre-configured filters (required)"
                }
            },
            "search_organizations": {
                "route": "/search_organization",
                "method": "GET",
                "name": "Search Organizations",
                "description": "Search for companies/organizations using various filters and criteria.",
                "payload": {
                    "q_organization_name": "Organization name search query (optional)",
                    "page": "Page number for pagination (required, default: 1)",
                    "organization_num_employees_ranges": "Employee count ranges. Values: 1-10, 1-20, 21-50, 51-100, 101-200, 201-500, 501-1000, 1001-2000, 2001-5000, 5001-10000, 10001 (for 10000+). For multiple ranges, separate with comma (optional)",
                    "organization_locations": "Locations to filter organizations. For multiple locations, separate with comma (e.g., 'United States,United Kingdom'). Cannot be used with zip_code (optional)",
                    "zip_code": "ZIP code for location-based search (e.g., 94105). Use with organization_location_radius. Cannot be used with organization_locations (optional)",
                    "organization_location_radius": "Radius in miles for ZIP code search. Values: 25, 50, 100, 300. Use with zip_code (optional)",
                    "organization_industry_tag_ids": "Industry tag IDs to filter organizations. For multiple values, separate with comma (optional)",
                    "q_organization_keyword_tags": "Keywords to match with organization name. For multiple values, separate with comma (optional)",
                    "organization_ids": "Apollo IDs of specific organizations to search. For multiple values, separate with comma (optional)"
                }
            },
            "search_organizations_via_url": {
                "route": "/search_organizations_via_url",
                "method": "POST",
                "name": "Search Organizations Via URL",
                "description": "Search for organizations using a pre-built Apollo.io URL with filters.",
                "payload": {
                    "url": "Apollo.io organizations search URL with pre-configured filters (required)"
                }
            },
            "person_details": {
                "route": "/person_details",
                "method": "GET",
                "name": "Person Details",
                "description": "Get detailed information about a specific person by their Apollo ID.",
                "payload": {
                    "person_id": "Apollo person ID (required)"
                }
            },
            "organization_details": {
                "route": "/organization_details",
                "method": "GET",
                "name": "Organization Details",
                "description": "Get detailed information about a specific organization by its Apollo ID.",
                "payload": {
                    "organization_id": "Apollo organization ID (required)"
                }
            },
            "organization_news": {
                "route": "/organization_news",
                "method": "GET",
                "name": "Organization News",
                "description": "Get recent news and updates about a specific organization.",
                "payload": {
                    "organization_id": "Apollo organization ID (required)",
                    "page": "Page number for pagination (required, default: 1)"
                }
            },
            "suggestion_location": {
                "route": "/suggestion_location",
                "method": "GET",
                "name": "Suggestion Location",
                "description": "Get location suggestions for search filters.",
                "payload": {
                    "query": "Location query string (optional)"
                }
            },
            "suggestion_job_title": {
                "route": "/suggestion_job_title",
                "method": "GET",
                "name": "Suggestion Job Title",
                "description": "Get job title suggestions for search filters.",
                "payload": {
                    "query": "Job title query string (required)"
                }
            },
            "suggestion_organization": {
                "route": "/suggestion_organization",
                "method": "GET",
                "name": "Suggestion Organization",
                "description": "Get organization/company name suggestions for search filters.",
                "payload": {
                    "query": "Organization query string (required)"
                }
            },
            "suggestion_industry": {
                "route": "/suggestion_industry",
                "method": "GET",
                "name": "Suggestion Industry",
                "description": "Get industry suggestions for search filters.",
                "payload": {
                    "query": "Industry query string (optional)"
                }
            }
        }
        base_url = "https://apollo-io-no-cookies-required.p.rapidapi.com"
        super().__init__(base_url, endpoints)


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    tool = ApolloProvider()

    # Example for searching people
    people_search = tool.call_endpoint(
        route="search_people",
        payload={
            "q_person_name": "John Smith",
            "page": 1,
            "person_titles": "Software Engineer,Senior Software Engineer",
            "person_locations": "United States,United Kingdom",
            "organization_num_employees_ranges": "101-200,201-500",
            "q_organization_keyword_tags": "technology,software",
            "contact_email_status_v2": "verified,likely_to_engage"
        }
    )
    print("People Search Result:", people_search)
    
    # Example for searching people with ZIP code radius
    people_search_zip = tool.call_endpoint(
        route="search_people",
        payload={
            "page": 1,
            "zip_code": "94102",
            "person_location_radius": "50",
            "person_titles": "CEO,CTO,Founder",
            "person_not_titles": "Assistant,Intern",
            "organization_num_employees_ranges": "51-100,101-200"
        }
    )
    print("People Search ZIP Result:", people_search_zip)
    
    # Example for searching organizations
    org_search = tool.call_endpoint(
        route="search_organizations",
        payload={
            "q_organization_name": "Google",
            "page": 1,
            "organization_locations": "United States,Canada",
            "organization_num_employees_ranges": "101-200,201-500",
            "q_organization_keyword_tags": "cloud,technology"
        }
    )
    print("Organization Search Result:", org_search)
    
    # Example for searching organizations with ZIP code and industry filters
    org_search_detailed = tool.call_endpoint(
        route="search_organizations",
        payload={
            "page": 1,
            "zip_code": "94105",
            "organization_location_radius": "100",
            "organization_num_employees_ranges": "501-1000,1001-2000",
            "organization_industry_tag_ids": "5567e1337369641ad2970000,5567e36f73696431a4970000",
            "q_organization_keyword_tags": "cloud,amazon"
        }
    )
    print("Organization Detailed Search Result:", org_search_detailed)
    
    # Example for searching specific organizations by Apollo IDs
    org_search_by_ids = tool.call_endpoint(
        route="search_organizations",
        payload={
            "page": 1,
            "organization_ids": "12345678,87654321,11223344"
        }
    )
    print("Organization Search by IDs Result:", org_search_by_ids)
    
    # Example for person details
    person_details = tool.call_endpoint(
        route="person_details",
        payload={
            "person_id": "12345678"
        }
    )
    print("Person Details Result:", person_details)
    
    # Example for organization details
    org_details = tool.call_endpoint(
        route="organization_details",
        payload={
            "organization_id": "87654321"
        }
    )
    print("Organization Details Result:", org_details)
    
    # Example for organization news
    org_news = tool.call_endpoint(
        route="organization_news",
        payload={
            "organization_id": "87654321",
            "page": 1
        }
    )
    print("Organization News Result:", org_news)
    
    # Example for location suggestions
    location_suggestions = tool.call_endpoint(
        route="suggestion_location",
        payload={
            "query": "San Francisco"
        }
    )
    print("Location Suggestions Result:", location_suggestions)
    
    # Example for job title suggestions
    job_title_suggestions = tool.call_endpoint(
        route="suggestion_job_title",
        payload={
            "query": "Software"
        }
    )
    print("Job Title Suggestions Result:", job_title_suggestions)
    
    # Example for organization suggestions
    org_suggestions = tool.call_endpoint(
        route="suggestion_organization",
        payload={
            "query": "Goo"
        }
    )
    print("Organization Suggestions Result:", org_suggestions)
    
    # Example for industry suggestions
    industry_suggestions = tool.call_endpoint(
        route="suggestion_industry",
        payload={
            "query": "Technology"
        }
    )
    print("Industry Suggestions Result:", industry_suggestions)
    
    # Example for search people via URL
    people_url_search = tool.call_endpoint(
        route="search_people_via_url",
        payload={
            "url": "https://app.apollo.io/#/people?page=1&finderViewId=5b6dfc6e73f78b0001f11ffa"
        }
    )
    print("People URL Search Result:", people_url_search)
    
    # Example for search organizations via URL
    org_url_search = tool.call_endpoint(
        route="search_organizations_via_url",
        payload={
            "url": "https://app.apollo.io/#/companies?page=1&finderViewId=5b6dfc6e73f78b0001f11ffa"
        }
    )
    print("Organizations URL Search Result:", org_url_search)
