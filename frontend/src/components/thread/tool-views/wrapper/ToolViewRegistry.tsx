import React, { useMemo } from 'react';
import { ToolViewProps } from '../types';
import { GenericToolView } from '../GenericToolView';
import { BrowserToolView } from '../BrowserToolView';
import { CommandToolView } from '../command-tool/CommandToolView';
import { ExposePortToolView } from '../expose-port-tool/ExposePortToolView';
import { FileOperationToolView } from '../file-operation/FileOperationToolView';
import { StrReplaceToolView } from '../str-replace/StrReplaceToolView';
import { WebCrawlToolView } from '../WebCrawlToolView';
import { WebScrapeToolView } from '../web-scrape-tool/WebScrapeToolView';
import { WebSearchToolView } from '../web-search-tool/WebSearchToolView';
import { SeeImageToolView } from '../see-image-tool/SeeImageToolView';
import { TerminateCommandToolView } from '../command-tool/TerminateCommandToolView';
import { AskToolView } from '../ask-tool/AskToolView';
import { CompleteToolView } from '../CompleteToolView';
import { ExecuteDataProviderCallToolView } from '../data-provider-tool/ExecuteDataProviderCallToolView';
import { DataProviderEndpointsToolView } from '../data-provider-tool/DataProviderEndpointsToolView';
import { DeployToolView } from '../DeployToolView';
import { SearchMcpServersToolView } from '../search-mcp-servers/search-mcp-servers';
import { GetAppDetailsToolView } from '../get-app-details/get-app-details';
import { CreateCredentialProfileToolView } from '../create-credential-profile/create-credential-profile';
import { ConnectCredentialProfileToolView } from '../connect-credential-profile/connect-credential-profile';
import { CheckProfileConnectionToolView } from '../check-profile-connection/check-profile-connection';
import { ConfigureProfileForAgentToolView } from '../configure-profile-for-agent/configure-profile-for-agent';
import { GetCredentialProfilesToolView } from '../get-credential-profiles/get-credential-profiles';
import { GetCurrentAgentConfigToolView } from '../get-current-agent-config/get-current-agent-config';


export type ToolViewComponent = React.ComponentType<ToolViewProps>;

type ToolViewRegistryType = Record<string, ToolViewComponent>;

const defaultRegistry: ToolViewRegistryType = {
  'browser-navigate-to': BrowserToolView,
  'browser-go-back': BrowserToolView,
  'browser-wait': BrowserToolView,
  'browser-click-element': BrowserToolView,
  'browser-input-text': BrowserToolView,
  'browser-send-keys': BrowserToolView,
  'browser-switch-tab': BrowserToolView,
  'browser-close-tab': BrowserToolView,
  'browser-scroll-down': BrowserToolView,
  'browser-scroll-up': BrowserToolView,
  'browser-scroll-to-text': BrowserToolView,
  'browser-get-dropdown-options': BrowserToolView,
  'browser-select-dropdown-option': BrowserToolView,
  'browser-drag-drop': BrowserToolView,
  'browser-click-coordinates': BrowserToolView,

  'execute-command': CommandToolView,
  'check-command-output': GenericToolView,
  'terminate-command': TerminateCommandToolView,
  'list-commands': GenericToolView,

  'create-file': FileOperationToolView,
  'delete-file': FileOperationToolView,
  'full-file-rewrite': FileOperationToolView,
  'read-file': FileOperationToolView,
  'edit-file': FileOperationToolView,

  'str-replace': StrReplaceToolView,

  'web-search': WebSearchToolView,
  'crawl-webpage': WebCrawlToolView,
  'scrape-webpage': WebScrapeToolView,

  'execute-data-provider-call': ExecuteDataProviderCallToolView,
  'get-data-provider-endpoints': DataProviderEndpointsToolView,

  'search-mcp-servers': SearchMcpServersToolView,
  'get-app-details': GetAppDetailsToolView,
  'create-credential-profile': CreateCredentialProfileToolView,
  'connect-credential-profile': ConnectCredentialProfileToolView,
  'check-profile-connection': CheckProfileConnectionToolView,
  'configure-profile-for-agent': ConfigureProfileForAgentToolView,
  'get-credential-profiles': GetCredentialProfilesToolView,
  'get-current-agent-config': GetCurrentAgentConfigToolView,

  'expose-port': ExposePortToolView,

  'see-image': SeeImageToolView,

  'call-mcp-tool': GenericToolView,

  'ask': AskToolView,
  'complete': CompleteToolView,

  'deploy': DeployToolView,

  'default': GenericToolView,
};

class ToolViewRegistry {
  private registry: ToolViewRegistryType;

  constructor(initialRegistry: Partial<ToolViewRegistryType> = {}) {
    this.registry = { ...defaultRegistry };
    
    // Only add non-undefined values from initialRegistry
    Object.entries(initialRegistry).forEach(([key, value]) => {
      if (value !== undefined) {
        this.registry[key] = value;
      }
    });
  }

  register(toolName: string, component: ToolViewComponent): void {
    this.registry[toolName] = component;
  }

  registerMany(components: Partial<ToolViewRegistryType>): void {
    Object.assign(this.registry, components);
  }

  get(toolName: string): ToolViewComponent {
    return this.registry[toolName] || this.registry['default'];
  }

  has(toolName: string): boolean {
    return toolName in this.registry;
  }

  getToolNames(): string[] {
    return Object.keys(this.registry).filter(key => key !== 'default');
  }

  clear(): void {
    this.registry = { default: this.registry['default'] };
  }
}

export const toolViewRegistry = new ToolViewRegistry();

export function useToolView(toolName: string): ToolViewComponent {
  return useMemo(() => toolViewRegistry.get(toolName), [toolName]);
}

export function ToolView({ name = 'default', ...props }: ToolViewProps) {
  const ToolViewComponent = useToolView(name);
  return <ToolViewComponent name={name} {...props} />;
}
