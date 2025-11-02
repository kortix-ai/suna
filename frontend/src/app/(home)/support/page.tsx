import { Metadata } from 'next';
import { Card, CardContent } from '@/components/ui/card';
import { Mail } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Support - Kortix',
  description: 'Contact Kortix support.',
};

export default function SupportPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/20 p-4">
      <Card className="max-w-md w-full">
        <CardContent className="pt-6">
          <div className="text-center">
            <div className="mx-auto w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
              <Mail className="w-6 h-6 text-primary" />
            </div>
            <h1 className="text-2xl font-semibold mb-2">Support</h1>
            <p className="text-muted-foreground mb-6">
              For support inquiries, please contact us at:
            </p>
            <a 
              href="mailto:support@kortix.com" 
              className="text-lg font-medium text-primary hover:underline inline-flex items-center gap-2"
            >
              <Mail className="w-5 h-5" />
              support@kortix.com
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}