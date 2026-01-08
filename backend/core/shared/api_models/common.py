"""Common API models used across multiple domains."""

from pydantic import BaseModel


class PaginationInfo(BaseModel):
    """Pagination information for list responses."""
    current_page: int
    page_size: int
    total_items: int
    total_pages: int
    has_next: bool
    has_previous: bool
