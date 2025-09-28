'use client';

// This component will be shown while the route is loading
export default function Loading() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-12 h-12 border-4 border-primary rounded-full border-t-transparent animate-spin"></div>
    </div>
  );
}
