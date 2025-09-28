import React from 'react';
import { ExternalLink, ShieldCheck, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Markdown } from '@/components/ui/markdown';

interface ComposioUrlDetectorProps {
  content: string;
  className?: string;
}

interface ComposioUrl {
  url: string;
  toolkitName: string | null;
  toolkitSlug: string | null;
  startIndex: number;
  endIndex: number;
}

// Common toolkit name mappings for better display
const TOOLKIT_NAME_MAPPINGS: Record<string, string> = {
  'gmail': 'Gmail',
  'github': 'GitHub', 
  'gitlab': 'GitLab',
  'google_sheets': 'Google Sheets',
  'google_drive': 'Google Drive',
  'google_calendar': 'Google Calendar',
  'notion': 'Notion',
  'slack': 'Slack',
  'discord': 'Discord',
  'twitter': 'Twitter',
  'linkedin': 'LinkedIn',
  'facebook': 'Facebook',
  'instagram': 'Instagram',
  'youtube': 'YouTube',
  'zoom': 'Zoom',
  'microsoft_teams': 'Microsoft Teams',
  'outlook': 'Outlook',
  'dropbox': 'Dropbox',
  'onedrive': 'OneDrive',
  'salesforce': 'Salesforce',
  'hubspot': 'HubSpot',
  'mailchimp': 'Mailchimp',
  'stripe': 'Stripe',
  'paypal': 'PayPal',
  'shopify': 'Shopify',
  'wordpress': 'WordPress',
  'airtable': 'Airtable',
  'monday': 'Monday.com',
  'asana': 'Asana',
  'trello': 'Trello',
  'jira': 'Jira',
  'figma': 'Figma',
  'twilio': 'Twilio',
  'aws': 'AWS',
  'google_cloud': 'Google Cloud',
  'azure': 'Azure',
};

// Toolkit logos/icons mapping
const TOOLKIT_LOGOS: Record<string, string> = {
  'gmail': 'https://cdn.jsdelivr.net/gh/ComposioHQ/open-logos@master/gmail.svg',
  'github': 'https://cdn.jsdelivr.net/gh/ComposioHQ/open-logos@master/github.svg',
  'slack': 'https://cdn.jsdelivr.net/gh/ComposioHQ/open-logos@master/slack.svg',
  'notion': 'https://cdn.jsdelivr.net/gh/ComposioHQ/open-logos@master/notion.svg',
  'google_sheets': 'https://cdn.jsdelivr.net/gh/ComposioHQ/open-logos@master/google-sheets.svg',
  'google_drive': 'https://cdn.jsdelivr.net/gh/ComposioHQ/open-logos@master/google-drive.svg',
  'linear': 'https://cdn.jsdelivr.net/gh/ComposioHQ/open-logos@master/linear.svg',
  'airtable': 'https://cdn.jsdelivr.net/gh/ComposioHQ/open-logos@master/airtable.svg',
  'asana': 'https://cdn.jsdelivr.net/gh/ComposioHQ/open-logos@master/asana.svg',
  'trello': 'https://cdn.jsdelivr.net/gh/ComposioHQ/open-logos@master/trello.svg',
  'salesforce': 'https://cdn.jsdelivr.net/gh/ComposioHQ/open-logos@master/salesforce.svg',
};

function formatToolkitName(toolkitSlug: string): string {
  // Check if we have a custom mapping first
  if (TOOLKIT_NAME_MAPPINGS[toolkitSlug.toLowerCase()]) {
    return TOOLKIT_NAME_MAPPINGS[toolkitSlug.toLowerCase()];
  }
  
  // Fall back to converting snake_case to Title Case
  return toolkitSlug
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function extractToolkitInfoFromContext(content: string, urlStartIndex: number): { toolkitName: string | null; toolkitSlug: string | null } {
  // Use a smaller, more focused context window
  const contextBefore = content.substring(Math.max(0, urlStartIndex - 200), urlStartIndex);
  const contextAfter = content.substring(urlStartIndex, Math.min(content.length, urlStartIndex + 100));
  
  // Look for the most recent/closest pattern before the URL
  // Pattern 1: [toolkit:slug:name] Authentication:
  let match = contextBefore.match(/\[toolkit:([^:]+):([^\]]+)\]\s+Authentication:\s*$/i);
  if (match) {
    const toolkitSlug = match[1].trim();
    const toolkitName = match[2].trim();
    return { toolkitName, toolkitSlug };
  }
  
  // Pattern 2: Service Name Authentication:
  match = contextBefore.match(/([A-Za-z]+(?:\s+[A-Za-z]+)*)\s+Authentication:\s*$/i);
  if (match) {
    const serviceName = match[1].trim();
    const slug = serviceName.toLowerCase().replace(/\s+/g, '_');
    return { toolkitName: serviceName, toolkitSlug: slug };
  }
  
  // Pattern 3: Numbered list with service name
  match = contextBefore.match(/\d+\.\s*([A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(?:Integration|Authentication)(?:\s+[^:\n]*)?:?\s*$/i);
  if (match) {
    const serviceName = match[1].trim();
    const slug = serviceName.toLowerCase().replace(/\s+/g, '_');
    return { toolkitName: serviceName, toolkitSlug: slug };
  }
  
  // Pattern 3b: Handle numbered list with emojis
  match = contextBefore.match(/\d+\.\s*([A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(?:Integration|Authentication)\s*[^\w\n]*\s*$/i);
  if (match) {
    const serviceName = match[1].trim();
    const slug = serviceName.toLowerCase().replace(/\s+/g, '_');
    return { toolkitName: serviceName, toolkitSlug: slug };
  }
  
  // Pattern 4: Service Authentication (for...)
  match = contextBefore.match(/([A-Za-z]+(?:\s+[A-Za-z]+)*)\s+Authentication\s+\([^)]*\)\s*:?\s*$/i);
  if (match) {
    const serviceName = match[1].trim();
    const slug = serviceName.toLowerCase().replace(/\s+/g, '_');
    return { toolkitName: serviceName, toolkitSlug: slug };
  }
  
  // Pattern 5: Look for "Sign in to [Service]" in the URL context
  const urlContext = contextAfter.substring(0, 100);
  match = urlContext.match(/Sign\s+in\s+to\s+([A-Za-z]+(?:\s+[A-Za-z]+)*)/i);
  if (match) {
    const serviceName = match[1].trim();
    const slug = serviceName.toLowerCase().replace(/\s+/g, '_');
    return { toolkitName: serviceName, toolkitSlug: slug };
  }
  
  // Pattern 6: Look in the immediate context before URL (within 100 chars)
  const immediateContext = content.substring(Math.max(0, urlStartIndex - 100), urlStartIndex);
  match = immediateContext.match(/([A-Za-z]+)\s+(?:authentication|auth|connect)\s*(?:link|url)?:?\s*$/i);
  if (match) {
    const serviceName = match[1].trim();
    const slug = serviceName.toLowerCase().replace(/\s+/g, '_');
    return { toolkitName: serviceName, toolkitSlug: slug };
  }
  
  // Pattern 7: Look for common toolkit names in the immediate context only
  const commonToolkits = Object.keys(TOOLKIT_NAME_MAPPINGS);
  for (const toolkit of commonToolkits) {
    const toolkitName = TOOLKIT_NAME_MAPPINGS[toolkit];
    // Only check in the immediate context before the URL
    if (immediateContext.toLowerCase().includes(toolkitName.toLowerCase())) {
      return { toolkitName, toolkitSlug: toolkit };
    }
  }
  
  return { toolkitName: null, toolkitSlug: null };
}

function detectComposioUrls(content: string): ComposioUrl[] {
  const authUrlPatterns = [
    /https:\/\/accounts\.google\.com\/oauth\/authorize\?[^\s)]+/g,
    /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s)]+/g,
    /https:\/\/github\.com\/login\/oauth\/authorize\?[^\s)]+/g,
    /https:\/\/api\.notion\.com\/v1\/oauth\/authorize\?[^\s)]+/g,
    /https:\/\/slack\.com\/oauth\/[^\s)]+/g,
    /https:\/\/[^\/\s]+\.slack\.com\/oauth\/[^\s)]+/g,
    /https:\/\/login\.microsoftonline\.com\/[^\s)]+/g,
    /https:\/\/[^\/\s]+\/oauth2?\/authorize\?[^\s)]+/g,
    /https:\/\/backend\.composio\.dev\/[^\s)]+/g,
    /https:\/\/[^\/\s]+\/auth\/[^\s)]+/g,
    /https:\/\/[^\/\s]+\/authorize\?[^\s)]+/g,
    /https:\/\/[^\/\s]+\/connect\/[^\s)]+/g,
    /https:\/\/[^\s)]+[?&](client_id|redirect_uri|response_type|scope)=[^\s)]+/g,
  ];
  
  const urls: ComposioUrl[] = [];
  const processedUrls = new Set<string>(); // To avoid duplicates
  
  for (const pattern of authUrlPatterns) {
    let match;
    pattern.lastIndex = 0; // Reset regex state
    while ((match = pattern.exec(content)) !== null) {
      const url = match[0];
      
      // Skip if we've already processed this URL
      if (processedUrls.has(url)) {
        continue;
      }
      
      processedUrls.add(url);
      const { toolkitName, toolkitSlug } = extractToolkitInfoFromContext(content, match.index);
      
      // Debug logging to help identify what's being detected
      console.log('ComposioUrlDetector Debug:', {
        url: url.substring(0, 50) + '...',
        toolkitName,
        toolkitSlug,
        contextBefore: content.substring(Math.max(0, match.index - 100), match.index)
      });
      
      urls.push({
        url,
        toolkitName,
        toolkitSlug,
        startIndex: match.index,
        endIndex: match.index + url.length
      });
    }
  }
  
  return urls.sort((a, b) => a.startIndex - b.startIndex);
}

function hasAuthUrlPattern(content: string, url: ComposioUrl): boolean {
  const beforeUrl = content.substring(Math.max(0, url.startIndex - 100), url.startIndex);
  // Updated pattern to also match [toolkit:slug:name] Authentication: format
  return /(?:(?:\[toolkit:[^:]+:[^\]]+\]|[A-Za-z]+(?:\s+[A-Za-z]+)*)\s+)?(?:authentication|auth|connect|visit)\s+(?:url|link)?:\s*$/i.test(beforeUrl);
}

interface ComposioConnectButtonProps {
  url: string;
  toolkitName?: string;
  toolkitSlug?: string;
}

const ComposioConnectButton: React.FC<ComposioConnectButtonProps> = ({ 
  url, 
  toolkitName,
  toolkitSlug
}) => {
  const displayName = toolkitName || (toolkitSlug ? formatToolkitName(toolkitSlug) : 'Service');
  const logoUrl = toolkitSlug ? TOOLKIT_LOGOS[toolkitSlug.toLowerCase()] : null;
  
  const handleConnect = () => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <Card className="my-4 p-0 border bg-muted/30">
      <CardContent className="px-4 py-2">
        <div className="flex items-center gap-3">
          <div className="flex-shrink-0">
            <div className="w-10 h-10 rounded-lg overflow-hidden bg-muted border flex items-center justify-center">
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt={`${displayName} logo`}
                  className="w-8 h-8 object-cover"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.style.display = 'none';
                    const parent = target.parentElement;
                    if (parent) {
                      parent.innerHTML = `<div class="w-full h-full flex items-center justify-center"><svg class="w-6 h-6 text-zinc-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clip-rule="evenodd" /></svg></div>`;
                    }
                  }}
                />
              ) : (
                <Server className="w-6 h-6 text-zinc-400" />
              )}
            </div>
          </div>
          
          <div className="flex-1 min-w-0 flex items-center gap-2 justify-between">
            <div className="flex flex-col mb-3">
              <div className="flex items-center">
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100 text-sm">
                    Sign in to {displayName}
                </h3>
              </div>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 -mt-1">
                Click to authorize access to your {displayName} account
              </p>
            </div>
            <Button
              onClick={handleConnect}
              size="sm"
              className="max-w-64"
            >
              <ExternalLink className="w-3 h-3" />
              Sign in
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export const ComposioUrlDetector: React.FC<ComposioUrlDetectorProps> = ({ 
  content, 
  className 
}) => {
  const composioUrls = detectComposioUrls(content);

  if (composioUrls.length === 0) {
    return (
      <Markdown className={className}>{content}</Markdown>
    );
  }

  const contentParts: React.ReactNode[] = [];
  let lastIndex = 0;

  composioUrls.forEach((composioUrl, index) => {
    if (composioUrl.startIndex > lastIndex) {
      const textBefore = content.substring(lastIndex, composioUrl.startIndex);
      
      const cleanedTextBefore = hasAuthUrlPattern(content, composioUrl)
        ? textBefore
            // Remove [toolkit:slug:name] pattern
            .replace(/\[toolkit:[^:]+:[^\]]+\]\s+/gi, '')
            // Remove authentication/auth/connect/visit url/link patterns
            .replace(/(?:authentication|auth|connect|visit)\s+(?:url|link)?:\s*$/i, '')
            .trim()
        : textBefore;

      if (cleanedTextBefore.trim()) {
        contentParts.push(
          <Markdown key={`text-${index}`} className={className}>{cleanedTextBefore}</Markdown>
        );
      }
    }

    contentParts.push(
      <ComposioConnectButton
        key={`composio-${index}`}
        url={composioUrl.url}
        toolkitName={composioUrl.toolkitName || undefined}
        toolkitSlug={composioUrl.toolkitSlug || undefined}
      />
    );

    lastIndex = composioUrl.endIndex;
  });

  if (lastIndex < content.length) {
    const remainingText = content.substring(lastIndex);
    if (remainingText.trim()) {
      contentParts.push(
        <Markdown key="text-final" className={className}>{remainingText}</Markdown>
      );
    }
  }

  return <>{contentParts}</>;
}; 