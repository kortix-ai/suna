from typing import Dict

from core.tools.data_providers.RapidDataProviderBase import RapidDataProviderBase, EndpointSchema


class ActiveJobsProvider(RapidDataProviderBase):
    def __init__(self):
        endpoints: Dict[str, EndpointSchema] = {
            "active_jobs": {
                "route": "/active-ats-7d",
                "method": "GET",
                "name": "Active Jobs Search",
                "description": "Get active job listings with various filter options.",
                "payload": {
                    "limit": "Optional. Number of jobs per API call (10-100). Default is 100.",
                    "offset": "Optional. Offset for pagination. Default is 0.",
                    "title_filter": "Optional. Search terms for job title.",
                    "advanced_title_filter": "Optional. Advanced title filter with operators (can't be used with title_filter).",
                    "location_filter": "Optional. Filter by location(s). Use full names like 'United States' not 'US'.",
                    "description_filter": "Optional. Filter on job description content.",
                    "organization_filter": "Optional. Filter by company name(s).",
                    "description_type": "Optional. Return format for description: 'text' or 'html'. Leave empty to exclude descriptions.",
                    "source": "Optional. Filter by ATS source.",
                    "date_filter": "Optional. Filter by posting date (greater than).",
                    "ai_employment_type_filter": "Optional. Filter by employment type (FULL_TIME, PART_TIME, etc).",
                    "ai_work_arrangement_filter": "Optional. Filter by work arrangement (On-site, Hybrid, Remote OK, Remote Solely).",
                    "ai_experience_level_filter": "Optional. Filter by experience level (0-2, 2-5, 5-10, 10+).",
                    "li_organization_slug_filter": "Optional. Filter by LinkedIn company slug.",
                    "li_organization_slug_exclusion_filter": "Optional. Exclude LinkedIn company slugs.",
                    "li_industry_filter": "Optional. Filter by LinkedIn industry.",
                    "li_organization_specialties_filter": "Optional. Filter by LinkedIn company specialties.",
                    "li_organization_description_filter": "Optional. Filter by LinkedIn company description."
                }
            }
        }
           
        base_url = "https://active-jobs-db.p.rapidapi.com"
        super().__init__(base_url, endpoints)


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    tool = ActiveJobsProvider()

    # Example for searching active jobs
    jobs = tool.call_endpoint(
        route="active_jobs",
        payload={
            "limit": "10",
            "offset": "0",
            "title_filter": "\"Data Engineer\"",
            "location_filter": "\"United States\" OR \"United Kingdom\"",
            "description_type": "text"
        }
    )
    print("Active Jobs:", jobs)