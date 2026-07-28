import { useEffect, useState } from 'react';

export function useGitHubStars(_owner?: string, _repo?: string) {
  const [stars, setStars] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStars = async () => {
      try {
        setLoading(true);
        const res = await fetch('/api/github-stars');
        if (!res.ok) throw new Error();
        const data = await res.json();
        setStars(data.stars);
      } catch {
        setStars(20000);
      } finally {
        setLoading(false);
      }
    };

    fetchStars();
  }, []);

  const formatStars = (count: number | null): string => {
    if (count === null) return '–';
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
    return count.toString();
  };

  return {
    stars,
    formattedStars: formatStars(stars),
    loading,
  };
}
