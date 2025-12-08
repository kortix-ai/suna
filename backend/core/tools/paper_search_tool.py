from typing import Optional, Dict, Any
import asyncio
import json
import aiohttp
import time
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.utils.config import config
from core.utils.logger import logger
from core.agentpress.thread_manager import ThreadManager

@tool_metadata(
    display_name="Academic Research",
    description="Search and analyze academic papers, authors, and scientific research",
    icon="GraduationCap",
    color="bg-emerald-100 dark:bg-emerald-800/50",
    weight=270,
    visible=True,
    usage_guide="""
### ACADEMIC PAPER SEARCH

**CAPABILITIES:**
- Search academic papers using Semantic Scholar API
- Find papers by keywords, authors, topics
- Get paper metadata: title, abstract, citations, authors, year
- Access DOI links and full paper information

**BEST PRACTICES:**
- Use specific academic terms and keywords
- Include author names when searching for specific researchers
- Filter by year range for recent research
- Cross-reference multiple papers for comprehensive understanding
- Check citation counts for paper impact assessment

**SEARCH STRATEGIES:**
- Topic-based: "machine learning attention mechanisms"
- Author-based: "Yoshua Bengio deep learning"
- Combined: "transformer architecture Vaswani 2017"
"""
)
class PaperSearchTool(Tool):
    def __init__(self, thread_manager: ThreadManager):
        super().__init__()
        self.thread_manager = thread_manager
        self.api_key = config.SEMANTIC_SCHOLAR_API_KEY
        self.base_url = "https://api.semanticscholar.org/graph/v1"
        self.last_request_time = 0
        self.request_lock = asyncio.Lock()
        
        if self.api_key:
            logger.info("Paper Search Tool initialized with Semantic Scholar API (Free)")
        else:
            logger.warning("SEMANTIC_SCHOLAR_API_KEY not configured - Paper Search Tool will not be available")
    
    async def _rate_limited_request(
        self,
        url: str,
        params: Optional[Dict[str, Any]] = None,
        max_retries: int = 3
    ) -> Dict[str, Any]:
        async with self.request_lock:
            current_time = time.time()
            time_since_last_request = current_time - self.last_request_time
            
            if time_since_last_request < 1.0:
                wait_time = 1.0 - time_since_last_request
                await asyncio.sleep(wait_time)
            
            headers = {"x-api-key": self.api_key} if self.api_key else {}
            
            for attempt in range(max_retries):
                try:
                    async with aiohttp.ClientSession() as session:
                        async with session.get(url, params=params, headers=headers) as response:
                            self.last_request_time = time.time()
                            
                            if response.status == 429:
                                retry_after = int(response.headers.get('Retry-After', 2 ** attempt))
                                logger.warning(f"Rate limited, waiting {retry_after}s before retry {attempt + 1}/{max_retries}")
                                await asyncio.sleep(retry_after)
                                continue
                            
                            if response.status == 200:
                                return await response.json()
                            else:
                                error_text = await response.text()
                                logger.error(f"API request failed with status {response.status}: {error_text}")
                                
                                if response.status >= 500 and attempt < max_retries - 1:
                                    wait_time = 2 ** attempt
                                    logger.info(f"Server error, retrying in {wait_time}s")
                                    await asyncio.sleep(wait_time)
                                    continue
                                
                                raise Exception(f"API request failed: {response.status} - {error_text}")
                
                except asyncio.TimeoutError:
                    if attempt < max_retries - 1:
                        wait_time = 2 ** attempt
                        logger.warning(f"Request timeout, retrying in {wait_time}s")
                        await asyncio.sleep(wait_time)
                        continue
                    raise
                except aiohttp.ClientError as e:
                    if attempt < max_retries - 1:
                        wait_time = 2 ** attempt
                        logger.warning(f"Request error: {e}, retrying in {wait_time}s")
                        await asyncio.sleep(wait_time)
                        continue
                    raise
            
            raise Exception(f"Failed after {max_retries} attempts")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "paper_search",
            "description": "Search for academic papers and research documents using Semantic Scholar (FREE). Returns up to 100 relevant papers with abstracts, authors, citations, and publication details. No cost to use.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query for finding academic papers. Can include keywords, topics, or concepts. Examples: 'transformer architectures', 'climate change mitigation', 'quantum computing'"
                    },
                    "year": {
                        "type": "string",
                        "description": "Filter by publication year range (e.g., '2020-2023' or '2023'). Optional."
                    },
                    "fields_of_study": {
                        "type": "string",
                        "description": "Comma-separated list of fields to filter by (e.g., 'Computer Science,Physics'). Optional."
                    },
                    "open_access_only": {
                        "type": "boolean",
                        "description": "If true, only return papers with open access PDFs. Default: false"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of results to return (1-100). Default: 10",
                        "default": 10
                    }
                },
                "required": ["query"]
            }
        }
    })
    async def paper_search(
        self,
        query: str,
        year: Optional[str] = None,
        fields_of_study: Optional[str] = None,
        open_access_only: bool = False,
        limit: int = 10
    ) -> ToolResult:
        if not self.api_key:
            return self.fail_response(
                "Paper Search is not available. SEMANTIC_SCHOLAR_API_KEY is not configured. "
                "Please contact your administrator to enable this feature."
            )
        
        if not query:
            return self.fail_response("Search query is required.")
        
        if limit < 1 or limit > 100:
            return self.fail_response("Limit must be between 1 and 100.")
        
        try:
            logger.info(f"Searching Semantic Scholar for: '{query}' (limit: {limit})")
            
            params = {
                "query": query,
                "limit": limit,
                "fields": "paperId,title,abstract,year,authors,url,venue,publicationVenue,citationCount,referenceCount,influentialCitationCount,isOpenAccess,openAccessPdf,fieldsOfStudy,s2FieldsOfStudy,publicationTypes,publicationDate,journal"
            }
            
            if year:
                params["year"] = year
            
            if fields_of_study:
                params["fieldsOfStudy"] = fields_of_study
            
            if open_access_only:
                params["openAccessPdf"] = ""
            
            url = f"{self.base_url}/paper/search"
            data = await self._rate_limited_request(url, params)
            
            results = data.get('data', [])
            total = data.get('total', 0)
            
            logger.info(f"Found {len(results)} papers (total available: {total})")
            
            formatted_results = []
            for idx, paper in enumerate(results, 1):
                authors_list = []
                for author in paper.get('authors', []):
                    authors_list.append({
                        "name": author.get('name', ''),
                        "author_id": author.get('authorId', '')
                    })
                
                open_access_pdf = paper.get('openAccessPdf')
                pdf_url = open_access_pdf.get('url') if open_access_pdf else None
                
                venue_info = paper.get('publicationVenue', {})
                if not venue_info:
                    venue_info = {}
                
                result_entry = {
                    "rank": idx,
                    "paper_id": paper.get('paperId', ''),
                    "title": paper.get('title', ''),
                    "abstract": paper.get('abstract', ''),
                    "year": paper.get('year'),
                    "url": paper.get('url', ''),
                    "authors": authors_list,
                    "venue": paper.get('venue', ''),
                    "venue_type": venue_info.get('type', ''),
                    "citation_count": paper.get('citationCount', 0),
                    "reference_count": paper.get('referenceCount', 0),
                    "influential_citation_count": paper.get('influentialCitationCount', 0),
                    "is_open_access": paper.get('isOpenAccess', False),
                    "pdf_url": pdf_url,
                    "fields_of_study": paper.get('fieldsOfStudy', []),
                    "publication_types": paper.get('publicationTypes', []),
                    "publication_date": paper.get('publicationDate', ''),
                    "journal": paper.get('journal', {}).get('name', '') if paper.get('journal') else ''
                }
                
                formatted_results.append(result_entry)
            
            output = {
                "query": query,
                "total_available": total,
                "results_returned": len(formatted_results),
                "results": formatted_results
            }
            
            logger.info(f"Successfully completed paper search with {len(formatted_results)} results")
            
            try:
                json_output = json.dumps(output, indent=2, default=str)
                return self.success_response(json_output)
            except Exception as json_error:
                logger.error(f"Failed to serialize paper search output: {json_error}")
                summary = f"Found {len(formatted_results)} papers for query: {query}"
                if formatted_results:
                    summary += f"\n\nTop result:\nTitle: {formatted_results[0].get('title', 'Unknown')}\nURL: {formatted_results[0].get('url', 'Unknown')}"
                return self.success_response(summary)
                
        except asyncio.TimeoutError:
            return self.fail_response("Paper search timed out. Please try again with a simpler query.")
        except Exception as e:
            logger.error(f"Paper search failed: {repr(e)}", exc_info=True)
            return self.fail_response(f"An error occurred during the paper search: {str(e)}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_paper_details",
            "description": "Get detailed information about a specific academic paper using its Semantic Scholar paper ID (FREE). Returns full details including abstract, authors, citations, references, and more. No cost to use.",
            "parameters": {
                "type": "object",
                "properties": {
                    "paper_id": {
                        "type": "string",
                        "description": "The Semantic Scholar paper ID (e.g., '5c5751d45e298cea054f32b392c12c61027d2fe7')"
                    },
                    "include_citations": {
                        "type": "boolean",
                        "description": "Include list of papers that cite this paper. Default: false"
                    },
                    "include_references": {
                        "type": "boolean",
                        "description": "Include list of papers referenced by this paper. Default: false"
                    }
                },
                "required": ["paper_id"]
            }
        }
    })
    async def get_paper_details(
        self,
        paper_id: str,
        include_citations: bool = False,
        include_references: bool = False
    ) -> ToolResult:
        if not self.api_key:
            return self.fail_response(
                "Paper Details is not available. SEMANTIC_SCHOLAR_API_KEY is not configured. "
                "Please contact your administrator to enable this feature."
            )
        
        if not paper_id:
            return self.fail_response("Paper ID is required.")
        
        try:
            logger.info(f"Fetching details for paper: {paper_id}")
            
            fields = "paperId,corpusId,title,abstract,year,authors,url,venue,publicationVenue,citationCount,referenceCount,influentialCitationCount,isOpenAccess,openAccessPdf,fieldsOfStudy,s2FieldsOfStudy,publicationTypes,publicationDate,journal,citationStyles,externalIds,tldr,embedding"
            
            if include_citations:
                fields += ",citations.paperId,citations.title,citations.year,citations.authors,citations.citationCount"
            
            if include_references:
                fields += ",references.paperId,references.title,references.year,references.authors,references.citationCount"
            
            url = f"{self.base_url}/paper/{paper_id}"
            params = {"fields": fields}
            
            data = await self._rate_limited_request(url, params)
            
            authors_list = []
            for author in data.get('authors', []):
                author_info = {
                    "author_id": author.get('authorId', ''),
                    "name": author.get('name', ''),
                    "url": author.get('url', ''),
                    "affiliations": author.get('affiliations', []),
                    "homepage": author.get('homepage', ''),
                    "paper_count": author.get('paperCount', 0),
                    "citation_count": author.get('citationCount', 0),
                    "h_index": author.get('hIndex', 0)
                }
                authors_list.append(author_info)
            
            open_access_pdf = data.get('openAccessPdf')
            pdf_info = None
            if open_access_pdf:
                pdf_info = {
                    "url": open_access_pdf.get('url'),
                    "status": open_access_pdf.get('status'),
                    "license": open_access_pdf.get('license')
                }
            
            venue_info = data.get('publicationVenue', {})
            if not venue_info:
                venue_info = {}
            
            citations_list = []
            if include_citations and data.get('citations'):
                for citation in data.get('citations', [])[:50]:
                    citation_authors = [a.get('name', '') for a in citation.get('authors', [])]
                    citations_list.append({
                        "paper_id": citation.get('paperId', ''),
                        "title": citation.get('title', ''),
                        "year": citation.get('year'),
                        "authors": citation_authors,
                        "citation_count": citation.get('citationCount', 0)
                    })
            
            references_list = []
            if include_references and data.get('references'):
                for reference in data.get('references', [])[:50]:
                    ref_authors = [a.get('name', '') for a in reference.get('authors', [])]
                    references_list.append({
                        "paper_id": reference.get('paperId', ''),
                        "title": reference.get('title', ''),
                        "year": reference.get('year'),
                        "authors": ref_authors,
                        "citation_count": reference.get('citationCount', 0)
                    })
            
            tldr_text = None
            if data.get('tldr'):
                tldr_text = data['tldr'].get('text', '')
            
            result = {
                "paper_id": data.get('paperId', ''),
                "corpus_id": data.get('corpusId'),
                "title": data.get('title', ''),
                "abstract": data.get('abstract', ''),
                "tldr": tldr_text,
                "year": data.get('year'),
                "url": data.get('url', ''),
                "authors": authors_list,
                "venue": data.get('venue', ''),
                "venue_name": venue_info.get('name', ''),
                "venue_type": venue_info.get('type', ''),
                "citation_count": data.get('citationCount', 0),
                "reference_count": data.get('referenceCount', 0),
                "influential_citation_count": data.get('influentialCitationCount', 0),
                "is_open_access": data.get('isOpenAccess', False),
                "pdf_info": pdf_info,
                "fields_of_study": data.get('fieldsOfStudy', []),
                "publication_types": data.get('publicationTypes', []),
                "publication_date": data.get('publicationDate', ''),
                "journal": data.get('journal', {}).get('name', '') if data.get('journal') else '',
                "external_ids": data.get('externalIds', {}),
                "citation_styles": data.get('citationStyles', {}),
                "citations": citations_list if include_citations else None,
                "references": references_list if include_references else None
            }
            
            output = {
                "paper": result
            }
            
            logger.info(f"Successfully fetched details for paper: {paper_id}")
            
            try:
                json_output = json.dumps(output, indent=2, default=str)
                return self.success_response(json_output)
            except Exception as json_error:
                logger.error(f"Failed to serialize paper details output: {json_error}")
                summary = f"Title: {result.get('title', 'Unknown')}\nYear: {result.get('year', 'Unknown')}\nCitations: {result.get('citation_count', 0)}\nURL: {result.get('url', 'Unknown')}"
                return self.success_response(summary)
                
        except Exception as e:
            logger.error(f"Get paper details failed: {repr(e)}", exc_info=True)
            return self.fail_response(f"An error occurred while fetching paper details: {str(e)}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "search_authors",
            "description": "Search for academic authors and researchers using Semantic Scholar (FREE). Returns author profiles with publication and citation metrics. No cost to use.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query for finding authors. Can be a name or partial name. Examples: 'Geoffrey Hinton', 'Yann LeCun', 'adam smith'"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of results to return (1-100). Default: 10",
                        "default": 10
                    }
                },
                "required": ["query"]
            }
        }
    })
    async def search_authors(
        self,
        query: str,
        limit: int = 10
    ) -> ToolResult:
        if not self.api_key:
            return self.fail_response(
                "Author Search is not available. SEMANTIC_SCHOLAR_API_KEY is not configured. "
                "Please contact your administrator to enable this feature."
            )
        
        if not query:
            return self.fail_response("Search query is required.")
        
        if limit < 1 or limit > 100:
            return self.fail_response("Limit must be between 1 and 100.")
        
        try:
            logger.info(f"Searching Semantic Scholar for authors: '{query}' (limit: {limit})")
            
            params = {
                "query": query,
                "limit": limit,
                "fields": "authorId,name,url,affiliations,homepage,paperCount,citationCount,hIndex,externalIds"
            }
            
            url = f"{self.base_url}/author/search"
            data = await self._rate_limited_request(url, params)
            
            results = data.get('data', [])
            total = data.get('total', 0)
            
            logger.info(f"Found {len(results)} authors (total available: {total})")
            
            formatted_results = []
            for idx, author in enumerate(results, 1):
                result_entry = {
                    "rank": idx,
                    "author_id": author.get('authorId', ''),
                    "name": author.get('name', ''),
                    "url": author.get('url', ''),
                    "affiliations": author.get('affiliations', []),
                    "homepage": author.get('homepage', ''),
                    "paper_count": author.get('paperCount', 0),
                    "citation_count": author.get('citationCount', 0),
                    "h_index": author.get('hIndex', 0),
                    "external_ids": author.get('externalIds', {})
                }
                formatted_results.append(result_entry)
            
            output = {
                "query": query,
                "total_available": total,
                "results_returned": len(formatted_results),
                "results": formatted_results
            }
            
            logger.info(f"Successfully completed author search with {len(formatted_results)} results")
            
            try:
                json_output = json.dumps(output, indent=2, default=str)
                return self.success_response(json_output)
            except Exception as json_error:
                logger.error(f"Failed to serialize author search output: {json_error}")
                summary = f"Found {len(formatted_results)} authors for query: {query}"
                if formatted_results:
                    summary += f"\n\nTop result:\nName: {formatted_results[0].get('name', 'Unknown')}\nURL: {formatted_results[0].get('url', 'Unknown')}"
                return self.success_response(summary)
                
        except asyncio.TimeoutError:
            return self.fail_response("Author search timed out. Please try again with a simpler query.")
        except Exception as e:
            logger.error(f"Author search failed: {repr(e)}", exc_info=True)
            return self.fail_response(f"An error occurred during the author search: {str(e)}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_author_details",
            "description": "Get detailed information about a specific author using their Semantic Scholar author ID (FREE). Returns author profile, metrics, and optionally their papers. No cost to use.",
            "parameters": {
                "type": "object",
                "properties": {
                    "author_id": {
                        "type": "string",
                        "description": "The Semantic Scholar author ID (e.g., '1741101')"
                    },
                    "include_papers": {
                        "type": "boolean",
                        "description": "Include list of papers by this author. Default: false"
                    },
                    "papers_limit": {
                        "type": "integer",
                        "description": "Number of papers to return if include_papers is true (1-100). Default: 10",
                        "default": 10
                    }
                },
                "required": ["author_id"]
            }
        }
    })
    async def get_author_details(
        self,
        author_id: str,
        include_papers: bool = False,
        papers_limit: int = 10
    ) -> ToolResult:
        if not self.api_key:
            return self.fail_response(
                "Author Details is not available. SEMANTIC_SCHOLAR_API_KEY is not configured. "
                "Please contact your administrator to enable this feature."
            )
        
        if not author_id:
            return self.fail_response("Author ID is required.")
        
        if papers_limit < 1 or papers_limit > 100:
            return self.fail_response("Papers limit must be between 1 and 100.")
        
        try:
            logger.info(f"Fetching details for author: {author_id}")
            
            fields = "authorId,name,url,affiliations,homepage,paperCount,citationCount,hIndex,externalIds"
            
            if include_papers:
                fields += ",papers.paperId,papers.title,papers.year,papers.citationCount,papers.url,papers.venue,papers.abstract"
            
            url = f"{self.base_url}/author/{author_id}"
            params = {"fields": fields}
            if include_papers:
                params["limit"] = papers_limit
            
            data = await self._rate_limited_request(url, params)
            
            papers_list = []
            if include_papers and data.get('papers'):
                for paper in data.get('papers', [])[:papers_limit]:
                    papers_list.append({
                        "paper_id": paper.get('paperId', ''),
                        "title": paper.get('title', ''),
                        "year": paper.get('year'),
                        "citation_count": paper.get('citationCount', 0),
                        "url": paper.get('url', ''),
                        "venue": paper.get('venue', ''),
                        "abstract": paper.get('abstract', '')
                    })
            
            result = {
                "author_id": data.get('authorId', ''),
                "name": data.get('name', ''),
                "url": data.get('url', ''),
                "affiliations": data.get('affiliations', []),
                "homepage": data.get('homepage', ''),
                "paper_count": data.get('paperCount', 0),
                "citation_count": data.get('citationCount', 0),
                "h_index": data.get('hIndex', 0),
                "external_ids": data.get('externalIds', {}),
                "papers": papers_list if include_papers else None
            }
            
            output = {
                "author": result
            }
            
            logger.info(f"Successfully fetched details for author: {author_id}")
            
            try:
                json_output = json.dumps(output, indent=2, default=str)
                return self.success_response(json_output)
            except Exception as json_error:
                logger.error(f"Failed to serialize author details output: {json_error}")
                summary = f"Name: {result.get('name', 'Unknown')}\nPapers: {result.get('paper_count', 0)}\nCitations: {result.get('citation_count', 0)}\nh-index: {result.get('h_index', 0)}\nURL: {result.get('url', 'Unknown')}"
                return self.success_response(summary)
                
        except Exception as e:
            logger.error(f"Get author details failed: {repr(e)}", exc_info=True)
            return self.fail_response(f"An error occurred while fetching author details: {str(e)}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_author_papers",
            "description": "Get all papers by a specific author using their Semantic Scholar author ID (FREE). Returns a list of their publications with details. No cost to use.",
            "parameters": {
                "type": "object",
                "properties": {
                    "author_id": {
                        "type": "string",
                        "description": "The Semantic Scholar author ID (e.g., '1741101')"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of papers to return (1-1000). Default: 100",
                        "default": 100
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Number of papers to skip for pagination. Default: 0",
                        "default": 0
                    }
                },
                "required": ["author_id"]
            }
        }
    })
    async def get_author_papers(
        self,
        author_id: str,
        limit: int = 100,
        offset: int = 0
    ) -> ToolResult:
        if not self.api_key:
            return self.fail_response(
                "Author Papers is not available. SEMANTIC_SCHOLAR_API_KEY is not configured. "
                "Please contact your administrator to enable this feature."
            )
        
        if not author_id:
            return self.fail_response("Author ID is required.")
        
        if limit < 1 or limit > 1000:
            return self.fail_response("Limit must be between 1 and 1000.")
        
        if offset < 0:
            return self.fail_response("Offset must be 0 or greater.")
        
        try:
            logger.info(f"Fetching papers for author: {author_id} (limit: {limit}, offset: {offset})")
            
            params = {
                "fields": "paperId,title,abstract,year,citationCount,referenceCount,influentialCitationCount,url,venue,publicationVenue,isOpenAccess,openAccessPdf,fieldsOfStudy,publicationTypes,publicationDate,journal",
                "limit": limit,
                "offset": offset
            }
            
            url = f"{self.base_url}/author/{author_id}/papers"
            data = await self._rate_limited_request(url, params)
            
            papers = data.get('data', [])
            next_offset = data.get('next')
            
            logger.info(f"Found {len(papers)} papers for author {author_id}")
            
            formatted_papers = []
            for idx, paper in enumerate(papers, 1):
                open_access_pdf = paper.get('openAccessPdf')
                pdf_url = open_access_pdf.get('url') if open_access_pdf else None
                
                venue_info = paper.get('publicationVenue', {})
                if not venue_info:
                    venue_info = {}
                
                paper_entry = {
                    "rank": offset + idx,
                    "paper_id": paper.get('paperId', ''),
                    "title": paper.get('title', ''),
                    "abstract": paper.get('abstract', ''),
                    "year": paper.get('year'),
                    "url": paper.get('url', ''),
                    "venue": paper.get('venue', ''),
                    "venue_type": venue_info.get('type', ''),
                    "citation_count": paper.get('citationCount', 0),
                    "reference_count": paper.get('referenceCount', 0),
                    "influential_citation_count": paper.get('influentialCitationCount', 0),
                    "is_open_access": paper.get('isOpenAccess', False),
                    "pdf_url": pdf_url,
                    "fields_of_study": paper.get('fieldsOfStudy', []),
                    "publication_types": paper.get('publicationTypes', []),
                    "publication_date": paper.get('publicationDate', ''),
                    "journal": paper.get('journal', {}).get('name', '') if paper.get('journal') else ''
                }
                formatted_papers.append(paper_entry)
            
            output = {
                "author_id": author_id,
                "papers_returned": len(formatted_papers),
                "offset": offset,
                "next_offset": next_offset,
                "has_more": next_offset is not None,
                "papers": formatted_papers
            }
            
            logger.info(f"Successfully fetched {len(formatted_papers)} papers for author: {author_id}")
            
            try:
                json_output = json.dumps(output, indent=2, default=str)
                return self.success_response(json_output)
            except Exception as json_error:
                logger.error(f"Failed to serialize author papers output: {json_error}")
                summary = f"Found {len(formatted_papers)} papers for author ID: {author_id}"
                if formatted_papers:
                    summary += f"\n\nTop paper:\nTitle: {formatted_papers[0].get('title', 'Unknown')}\nYear: {formatted_papers[0].get('year', 'Unknown')}"
                return self.success_response(summary)
                
        except Exception as e:
            logger.error(f"Get author papers failed: {repr(e)}", exc_info=True)
            return self.fail_response(f"An error occurred while fetching author papers: {str(e)}")
    