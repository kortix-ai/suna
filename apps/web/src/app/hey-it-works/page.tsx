import { CheckCircle2 } from 'lucide-react';

export const metadata = {
  title: 'Hey, it works!',
};

export default function HeyItWorksPage() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-lg w-full text-center space-y-6">
        {/* Icon */}
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-emerald-500/10 border border-emerald-500/20">
          <CheckCircle2 className="h-10 w-10 text-emerald-500" />
        </div>

        {/* Title */}
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Hey, it works!
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-md mx-auto">
            If you can see this page, the web app is up and serving routes correctly.
          </p>
        </div>
      </div>
    </div>
  );
}
