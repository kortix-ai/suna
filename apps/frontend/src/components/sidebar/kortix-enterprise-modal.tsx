import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMediaQuery } from '@/hooks/utils';
import Image from 'next/image';
import Cal, { getCalApi } from '@calcom/embed-react';
import { useTheme } from 'next-themes';
import { Check, Calendar } from 'lucide-react';
import { KortixLogo } from './kortix-logo';

interface EnterpriseModalProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function KortixEnterpriseModal({
  children,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange
}: EnterpriseModalProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const { resolvedTheme } = useTheme();
  const isDarkMode = resolvedTheme === 'dark';

  // Use controlled or internal state
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = controlledOnOpenChange || setInternalOpen;

  useEffect(() => {
    (async function () {
      const cal = await getCalApi({ namespace: 'enterprise-demo' });
      cal('ui', { hideEventTypeDetails: true, layout: 'month_view' });
    })();
  }, []);

  const benefits = [
    "Dedicated solution architect assigned",
    "Enterprise-grade security & compliance",
    "Custom integration with existing systems",
    "Comprehensive team training included",
    "Priority support & ongoing optimization",
    "Scalable architecture for growth",
    "Performance monitoring & analytics",
    "100% satisfaction guarantee"
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children}
      </DialogTrigger>
      <DialogContent className="p-0 gap-0 border-none max-w-[90vw] lg:max-w-[80vw] xl:max-w-[70vw] rounded-xl overflow-hidden">
        <DialogTitle className="sr-only">
          Enterprise AI Implementation - Schedule Consultation
        </DialogTitle>
        <div className="grid grid-cols-1 lg:grid-cols-2 h-[700px] lg:h-[800px]">
          {/* Enhanced Info Panel */}
          <div className="p-6 lg:p-8 flex flex-col bg-white dark:bg-black relative h-full overflow-y-auto border-r border-gray-200 dark:border-gray-800">
            <div className="relative z-10 flex flex-col h-full">
              <div className="mb-6 flex-shrink-0">
                <KortixLogo size={30} variant="logomark" />
              </div>

              <div className="mb-6 flex-shrink-0">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gradient-to-r from-primary/10 to-secondary/10 border border-primary/20 mb-4">
                  <div className="w-2 h-2 rounded-full bg-primary"></div>
                  <span className="text-xs font-medium text-primary">Enterprise Implementation</span>
                </div>

                <h2 className="text-2xl lg:text-3xl font-semibold tracking-tight mb-3 text-foreground">
                  Let's Design Your Custom AI Solution
                </h2>
                <p className="text-base lg:text-lg text-muted-foreground mb-6 leading-relaxed">
                  Schedule a strategy session with our solution architects to explore how custom AI workers can transform your specific business processes and workflows.
                </p>
              </div>

              <div className="border-t border-gray-200 dark:border-gray-800 pt-6 flex-1">
                <h3 className="text-lg font-semibold mb-4 text-foreground">What's Included</h3>
                <div className="space-y-3">
                  {benefits.map((benefit, index) => (
                    <div key={index} className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center mt-0.5">
                        <Check className="w-3 h-3 text-primary" />
                      </div>
                      <p className="text-sm text-muted-foreground leading-relaxed">{benefit}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-gray-200 dark:border-gray-800 pt-4 mt-6 flex-shrink-0">
                <div className="text-center space-y-2">
                  <div className="flex items-center justify-center gap-2 text-sm font-medium text-foreground">
                    <Calendar className="w-4 h-4 text-primary" />
                    <span>Free Strategy Session</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    30-minute consultation • No commitment required
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Calendar Panel */}
          <div className="bg-white dark:bg-[#171717] h-full overflow-hidden">
            <div className="h-full overflow-auto">
              <Cal
                namespace="enterprise-demo"
                calLink="team/kortix/enterprise-demo"
                style={{ width: '100%', height: '100%' }}
                config={{
                  layout: 'month_view',
                  hideEventTypeDetails: 'false',
                }}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Export with original name for backwards compatibility
export const KortixProcessModal = KortixEnterpriseModal;
