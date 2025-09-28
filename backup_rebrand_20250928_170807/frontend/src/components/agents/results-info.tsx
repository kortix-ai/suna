import React from 'react';

interface ResultsInfoProps {
  isLoading: boolean;
  totalAgents: number;
  filteredCount: number;
  currentPage?: number;
  totalPages?: number;
}

export const ResultsInfo = ({
  isLoading,
  totalAgents,
  filteredCount,
  currentPage,
  totalPages
}: ResultsInfoProps) => {

  if (isLoading || totalAgents === 0) {
    return null;
  }

  const showingText = () => {
    if (currentPage && totalPages && totalPages > 1) {
      return `Showing page ${currentPage} of ${totalPages} (${totalAgents} total agents)`;
    }
    return `Showing ${filteredCount} of ${totalAgents} agents`;
  };

  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span>
        {showingText()}
      </span>
    </div>
  );
}