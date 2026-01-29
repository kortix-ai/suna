"""
Use Case Clustering Service

Groups similar use cases using embedding-based semantic clustering.
This allows grouping free-form use case descriptions like:
- "create sales ppt", "make presentation", "build slides" -> "create presentation" cluster

Uses Agglomerative Clustering with cosine distance on embeddings.
"""

from typing import List, Dict, Any, Optional
import numpy as np
from collections import Counter

from core.services.supabase import DBConnection
from core.utils.logger import logger


async def get_clustered_use_cases(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    distance_threshold: float = 0.3,
    min_cluster_size: int = 2
) -> List[Dict[str, Any]]:
    """
    Fetch use cases with embeddings and cluster them by semantic similarity.

    Args:
        date_from: Start date in YYYY-MM-DD format
        date_to: End date in YYYY-MM-DD format
        distance_threshold: Cosine distance threshold for clustering (lower = tighter clusters)
        min_cluster_size: Minimum items to form a cluster

    Returns:
        List of clusters:
        [
            {
                "cluster_id": 0,
                "label": "create presentation",  # Most common use case in cluster
                "count": 15,
                "use_cases": ["create sales ppt", "make presentation", "build slides"],
                "examples": [{"use_case_summary": "...", "thread_id": "...", "account_id": "..."}]
            },
            ...
        ]
    """
    try:
        db = DBConnection()
        client = await db.client

        # Fetch use cases with embeddings
        query = client.from_('conversation_analytics')\
            .select('id, use_case_category, use_case_summary, use_case_embedding, thread_id, account_id')\
            .not_.is_('use_case_embedding', 'null')

        if date_from:
            query = query.gte('analyzed_at', f"{date_from}T00:00:00Z")
        if date_to:
            query = query.lte('analyzed_at', f"{date_to}T23:59:59Z")

        result = await query.execute()
        records = result.data or []

        if len(records) < min_cluster_size:
            logger.debug(f"[CLUSTERING] Not enough records ({len(records)}) for clustering")
            return []

        # Parse embeddings from string format and filter valid ones
        valid_records = []
        embeddings_list = []
        for r in records:
            embedding = r.get('use_case_embedding')
            if embedding:
                try:
                    # Handle different embedding formats
                    if isinstance(embedding, str):
                        # Parse string format "[0.1,0.2,...]"
                        embedding = [float(x) for x in embedding.strip('[]').split(',')]
                    elif isinstance(embedding, list):
                        embedding = [float(x) for x in embedding]
                    else:
                        continue

                    if len(embedding) > 0:
                        embeddings_list.append(embedding)
                        valid_records.append(r)
                except (ValueError, TypeError) as e:
                    logger.warning(f"[CLUSTERING] Failed to parse embedding: {e}")
                    continue

        if len(valid_records) < min_cluster_size:
            logger.debug(f"[CLUSTERING] Not enough valid embeddings ({len(valid_records)}) for clustering")
            return []

        # Convert to numpy array
        embeddings = np.array(embeddings_list)

        # Import sklearn here to avoid startup overhead
        try:
            from sklearn.cluster import AgglomerativeClustering
        except ImportError:
            logger.error("[CLUSTERING] sklearn not installed. Install with: pip install scikit-learn")
            raise ImportError("scikit-learn is required for clustering. Install with: pip install scikit-learn")

        # Perform agglomerative clustering with cosine distance
        clustering = AgglomerativeClustering(
            n_clusters=None,
            distance_threshold=distance_threshold,
            metric='cosine',
            linkage='average'
        )
        labels = clustering.fit_predict(embeddings)

        # Group records by cluster label
        clusters: Dict[int, List[Dict]] = {}
        for i, label in enumerate(labels):
            label = int(label)
            if label not in clusters:
                clusters[label] = []
            clusters[label].append(valid_records[i])

        # Format output
        result_clusters = []
        for cluster_id, items in clusters.items():
            if len(items) < min_cluster_size:
                continue  # Skip small clusters

            # Use category as primary label (more consistent for clustering)
            # Fall back to summary if category not available
            categories = [item.get('use_case_category') or item.get('use_case_summary') for item in items]
            most_common_category = Counter(categories).most_common(1)[0][0]

            # Collect unique summaries for detail
            summaries = list(set(item.get('use_case_summary') for item in items if item.get('use_case_summary')))

            result_clusters.append({
                "cluster_id": cluster_id,
                "label": most_common_category,
                "count": len(items),
                "use_cases": summaries,  # Specific task descriptions
                "categories": list(set(categories)),  # Categories in this cluster
                "examples": [
                    {
                        "category": item.get('use_case_category'),
                        "use_case_summary": item.get('use_case_summary'),
                        "thread_id": item['thread_id'],
                        "account_id": item['account_id']
                    }
                    for item in items[:5]  # First 5 examples
                ]
            })

        # Sort by count descending
        result_clusters.sort(key=lambda x: x['count'], reverse=True)

        logger.info(f"[CLUSTERING] Created {len(result_clusters)} clusters from {len(valid_records)} use cases")
        return result_clusters

    except ImportError:
        raise
    except Exception as e:
        logger.error(f"[CLUSTERING] Failed to cluster use cases: {e}", exc_info=True)
        raise
