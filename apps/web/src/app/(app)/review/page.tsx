import { ReviewCenter } from '@/features/review-center/review-center';

export const metadata = {
  title: 'Review Center',
  description: 'Review changes, approvals, agent outputs and questions in one place.',
};

/**
 * Review Center — clickable prototype (mock data only). Self-contained: no API,
 * auth or provider dependency, so it renders in the preview. `/review` is added
 * to PUBLIC_ROUTES in middleware.ts for the same reason. See
 * docs/REVIEW_CENTER_DESIGN.md.
 */
export default function ReviewPage() {
  return (
    <div className="bg-background h-dvh min-h-dvh">
      <ReviewCenter />
    </div>
  );
}
