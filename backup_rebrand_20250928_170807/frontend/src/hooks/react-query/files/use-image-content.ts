import React from 'react';
import { useFileContentQuery } from './use-file-queries';

export function useImageContent(
  sandboxId?: string,
  filePath?: string,
  options: {
    enabled?: boolean;
    staleTime?: number;
  } = {}
) {
  const [blobUrl, setBlobUrl] = React.useState<string | null>(null);

  const {
    data: blobData,
    isLoading,
    error,
  } = useFileContentQuery(sandboxId, filePath, {
    contentType: 'blob',
    enabled: options.enabled,
    staleTime: options.staleTime || 5 * 60 * 1000,
  });

  React.useEffect(() => {
    if (blobData instanceof Blob) {
      const url = URL.createObjectURL(blobData);
      setBlobUrl(url);
      return () => {
        URL.revokeObjectURL(url);
        setBlobUrl(null);
      };
    } else {
      setBlobUrl(null);
      return;
    }
  }, [blobData, filePath]);

  return {
    data: blobUrl,
    isLoading,
    error,
  };
} 