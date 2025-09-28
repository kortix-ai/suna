from typing import Dict

from core.tools.data_providers.RapidDataProviderBase import RapidDataProviderBase, EndpointSchema


class LinkedinProvider(RapidDataProviderBase):
    def __init__(self):
        endpoints: Dict[str, EndpointSchema] = {
            "person": {
                "route": "/person",
                "method": "POST",
                "name": "Person Data",
                "description": "Fetches any Linkedin profiles data including skills, certificates, experiences, qualifications and much more.",
                "payload": {
                    "link": "LinkedIn Profile URL"
                }
            },
            "person_urn": {
                "route": "/person_urn",
                "method": "POST",
                "name": "Person Data (Using Urn)",
                "description": "It takes profile urn instead of profile public identifier in input",
                "payload": {
                    "link": "LinkedIn Profile URL or URN"
                }
            },
            "person_deep": {
                "route": "/person_deep",
                "method": "POST",
                "name": "Person Data (Deep)",
                "description": "Fetches all experiences, educations, skills, languages, publications... related to a profile.",
                "payload": {
                    "link": "LinkedIn Profile URL"
                }
            },
            "profile_updates": {
                "route": "/profile_updates",
                "method": "GET",
                "name": "Person Posts (WITH PAGINATION)",
                "description": "Fetches posts of a linkedin profile alongwith reactions, comments, postLink and reposts data.",
                "payload": {
                    "profile_url": "LinkedIn Profile URL",
                    "page": "Page number",
                    "reposts": "Include reposts (1 or 0)",
                    "comments": "Include comments (1 or 0)"
                }
            },
            "profile_recent_comments": {
                "route": "/profile_recent_comments",
                "method": "POST",
                "name": "Person Recent Activity (Comments on Posts)",
                "description": "Fetches 20 most recent comments posted by a linkedin user (per page).",
                "payload": {
                    "profile_url": "LinkedIn Profile URL",
                    "page": "Page number",
                    "paginationToken": "Token for pagination"
                }
            },
            "comments_from_recent_activity": {
                "route": "/comments_from_recent_activity",
                "method": "GET",
                "name": "Comments from recent activity",
                "description": "Fetches recent comments posted by a person as per his recent activity tab.",
                "payload": {
                    "profile_url": "LinkedIn Profile URL",
                    "page": "Page number"
                }
            },
            "person_skills": {
                "route": "/person_skills",
                "method": "POST",
                "name": "Person Skills",
                "description": "Scraper all skills of a linkedin user",
                "payload": {
                    "link": "LinkedIn Profile URL"
                }
            },
            "email_to_linkedin_profile": {
                "route": "/email_to_linkedin_profile",
                "method": "POST",
                "name": "Email to LinkedIn Profile",
                "description": "Finds LinkedIn profile associated with an email address",
                "payload": {
                    "email": "Email address to search"
                }
            },
            "company": {
                "route": "/company",
                "method": "POST",
                "name": "Company Data",
                "description": "Fetches LinkedIn company profile data",
                "payload": {
                    "link": "LinkedIn Company URL"
                }
            },
            "web_domain": {
                "route": "/web-domain",
                "method": "POST",
                "name": "Web Domain to Company",
                "description": "Fetches LinkedIn company profile data from a web domain",
                "payload": {
                    "link": "Website domain (e.g., huzzle.app)"
                }
            },
            "similar_profiles": {
                "route": "/similar_profiles",
                "method": "GET",
                "name": "Similar Profiles",
                "description": "Fetches profiles similar to a given LinkedIn profile",
                "payload": {
                    "profileUrl": "LinkedIn Profile URL"
                }
            },
            "company_jobs": {
                "route": "/company_jobs",
                "method": "POST",
                "name": "Company Jobs",
                "description": "Fetches job listings from a LinkedIn company page",
                "payload": {
                    "company_url": "LinkedIn Company URL",
                    "count": "Number of job listings to fetch"
                }
            },
            "company_updates": {
                "route": "/company_updates",
                "method": "GET",
                "name": "Company Posts",
                "description": "Fetches posts from a LinkedIn company page",
                "payload": {
                    "company_url": "LinkedIn Company URL",
                    "page": "Page number",
                    "reposts": "Include reposts (0, 1, or 2)",
                    "comments": "Include comments (0, 1, or 2)"
                }
            },
            "company_employee": {
                "route": "/company_employee",
                "method": "GET",
                "name": "Company Employees",
                "description": "Fetches employees of a LinkedIn company using company ID",
                "payload": {
                    "companyId": "LinkedIn Company ID",
                    "page": "Page number"
                }
            },
            "company_updates_post": {
                "route": "/company_updates",
                "method": "POST",
                "name": "Company Posts (POST)",
                "description": "Fetches posts from a LinkedIn company page with specific count parameters",
                "payload": {
                    "company_url": "LinkedIn Company URL",
                    "posts": "Number of posts to fetch",
                    "comments": "Number of comments to fetch per post",
                    "reposts": "Number of reposts to fetch"
                }
            },
            "search_posts_with_filters": {
                "route": "/search_posts_with_filters",
                "method": "GET",
                "name": "Search Posts With Filters",
                "description": "Searches LinkedIn posts with various filtering options",
                "payload": {
                    "query": "Keywords/Search terms (text you put in LinkedIn search bar)",
                    "page": "Page number (1-100, each page contains 20 results)",
                    "sort_by": "Sort method: 'relevance' (Top match) or 'date_posted' (Latest)",
                    "author_job_title": "Filter by job title of author (e.g., CEO)",
                    "content_type": "Type of content post contains (photos, videos, liveVideos, collaborativeArticles, documents)",
                    "from_member": "URN of person who posted (comma-separated for multiple)",
                    "from_organization": "ID of organization who posted (comma-separated for multiple)",
                    "author_company": "ID of company author works for (comma-separated for multiple)",
                    "author_industry": "URN of industry author is connected with (comma-separated for multiple)",
                    "mentions_member": "URN of person mentioned in post (comma-separated for multiple)",
                    "mentions_organization": "ID of organization mentioned in post (comma-separated for multiple)"
                }
            },
            "search_jobs": {
                "route": "/search_jobs",
                "method": "GET",
                "name": "Search Jobs",
                "description": "Searches LinkedIn jobs with various filtering options",
                "payload": {
                    "query": "Job search keywords (e.g., Software developer)",
                    "page": "Page number",
                    "searchLocationId": "Location ID for job search (get from Suggestion location endpoint)",
                    "easyApply": "Filter for easy apply jobs (true or false)",
                    "experience": "Experience level required (1=Internship, 2=Entry level, 3=Associate, 4=Mid senior, 5=Director, 6=Executive, comma-separated)",
                    "jobType": "Job type (F=Full time, P=Part time, C=Contract, T=Temporary, V=Volunteer, I=Internship, O=Other, comma-separated)",
                    "postedAgo": "Time jobs were posted in seconds (e.g., 3600 for past hour)",
                    "workplaceType": "Workplace type (1=On-Site, 2=Remote, 3=Hybrid, comma-separated)",
                    "sortBy": "Sort method (DD=most recent, R=most relevant)",
                    "companyIdsList": "List of company IDs, comma-separated",
                    "industryIdsList": "List of industry IDs, comma-separated",
                    "functionIdsList": "List of function IDs, comma-separated",
                    "titleIdsList": "List of job title IDs, comma-separated",
                    "locationIdsList": "List of location IDs within specified searchLocationId country, comma-separated"
                }
            },
            "search_people_with_filters": {
                "route": "/search_people_with_filters",
                "method": "POST",
                "name": "Search People With Filters",
                "description": "Searches LinkedIn profiles with detailed filtering options",
                "payload": {
                    "keyword": "General search keyword",
                    "page": "Page number",
                    "title_free_text": "Job title to filter by (e.g., CEO)",
                    "company_free_text": "Company name to filter by",
                    "first_name": "First name of person",
                    "last_name": "Last name of person",
                    "current_company_list": "List of current companies (comma-separated IDs)",
                    "past_company_list": "List of past companies (comma-separated IDs)",
                    "location_list": "List of locations (comma-separated IDs)",
                    "language_list": "List of languages (comma-separated)",
                    "service_catagory_list": "List of service categories (comma-separated)",
                    "school_free_text": "School name to filter by",
                    "industry_list": "List of industries (comma-separated IDs)",
                    "school_list": "List of schools (comma-separated IDs)"
                }
            },
            "search_company_with_filters": {
                "route": "/search_company_with_filters",
                "method": "POST",
                "name": "Search Company With Filters",
                "description": "Searches LinkedIn companies with detailed filtering options",
                "payload": {
                    "keyword": "General search keyword",
                    "page": "Page number",
                    "company_size_list": "List of company sizes (comma-separated, e.g., A,D)",
                    "hasJobs": "Filter companies with jobs (true or false)",
                    "location_list": "List of location IDs (comma-separated)",
                    "industry_list": "List of industry IDs (comma-separated)"
                }
            }
        }
        base_url = "https://linkedin-data-scraper.p.rapidapi.com"
        super().__init__(base_url, endpoints)


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    tool = LinkedinProvider()

    result = tool.call_endpoint(
        route="comments_from_recent_activity",
        payload={"profile_url": "https://www.linkedin.com/in/adamcohenhillel/", "page": 1}
    )
    print(result)

