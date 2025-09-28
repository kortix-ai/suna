import { useState, useEffect } from 'react';

interface GitHubRepoData {
  stargazers_count: number;
}

export function useGitHubStars(owner: string, repo: string) {
  const [stars, setStars] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStars = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
          },
        });

        if (!response.ok) {
          throw new Error(`GitHub API error: ${response.status}`);
        }

        const data: GitHubRepoData = await response.json();
        setStars(data.stargazers_count);
      } catch (err) {
        console.error('Failed to fetch GitHub stars:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch stars');
        // Fallback to static number if API fails
        setStars(20000); // Current approximate count
      } finally {
        setLoading(false);
      }
    };

    fetchStars();

    // Refresh every 5 minutes
    const interval = setInterval(fetchStars, 5 * 60 * 1000);
    
    return () => clearInterval(interval);
  }, [owner, repo]);

  // Format number (e.g., 17200 -> "17.2k")
  const formatStars = (count: number | null): string => {
    if (count === null) return '20.0k'; // Fallback while loading
    
    if (count >= 1000) {
      const formatted = (count / 1000).toFixed(1);
      return `${formatted}k`;
    }
    
    return count.toString();
  };

  return {
    stars,
    formattedStars: formatStars(stars),
    loading,
    error,
  };
}