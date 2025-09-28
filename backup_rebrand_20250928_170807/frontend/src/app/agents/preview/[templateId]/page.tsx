'use client';

import { redirect, useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { MarketplaceTemplate } from '@/components/agents/installation/types';
import { AgentTemplateLandingPage } from '@/components/agents/template-preview/agent-template-landing-page';
import { Loader2 } from 'lucide-react';

export default function AgentPreviewPage() {
    redirect('/dashboard');
//   const params = useParams();
//   const templateId = params.templateId as string;

//   const { data: template, isLoading, error } = useQuery({
//     queryKey: ['template', templateId],
//     queryFn: async () => {
//       const response = await backendApi.get<MarketplaceTemplate>(`/templates/${templateId}`);
//       return response.data;
//     },
//     enabled: !!templateId,
//   });

//   if (isLoading) {
//     return (
//       <div className="flex items-center justify-center min-h-screen">
//         <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
//       </div>
//     );
//   }

//   if (error || !template) {
//     return (
//       <div className="flex items-center justify-center min-h-screen">
//         <div className="text-center">
//           <h2 className="text-2xl font-semibold mb-2">Template not found</h2>
//           <p className="text-muted-foreground">The template you're looking for doesn't exist or has been removed.</p>
//         </div>
//       </div>
//     );
//   }

//   return <AgentTemplateLandingPage template={template} />;
} 