import React from 'react';
import { View } from 'react-native';
import { AskToolView } from './AskToolView';
import { BrowserToolView } from './BrowserToolView';
import { CommandToolView } from './CommandToolView';
import { CompleteToolView } from './CompleteToolView';
import { DataProviderEndpointsToolView } from './DataProviderEndpointsToolView';
import { DeployToolView } from './DeployToolView';
import { ExecuteDataProviderCallToolView } from './ExecuteDataProviderCallToolView';
import { ExposePortToolView } from './ExposePortToolView';
import { FileOperationToolView } from './FileOperationToolView';
import { GenericToolView } from './GenericToolView';
import { SeeImageToolView } from './SeeImageToolView';
import { StrReplaceToolView } from './StrReplaceToolView';
import { TerminateCommandToolView } from './TerminateCommandToolView';
import { ToolHeader } from './ToolHeader';
import { ToolViewProvider } from './ToolViewContext';
import { WebCrawlToolView } from './WebCrawlToolView';
import { WebScrapeToolView } from './WebScrapeToolView';
import { WebSearchToolView } from './WebSearchToolView';

export interface ToolViewProps {
    name?: string;
    toolCall?: any;
    isStreaming?: boolean;
    isSuccess?: boolean;
    onFilePress?: (filePath: string) => void;
    sandboxId?: string;
    messages?: any[]; // Add messages prop for complete tool
    browserState?: any; // Browser state data for browser tools
    // Future props can be added here
    [key: string]: any;
}

export type ToolViewComponent = React.ComponentType<ToolViewProps>;

const defaultRegistry: Record<string, ToolViewComponent> = {
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

    'ask': AskToolView,
    'complete': CompleteToolView,
    'default': GenericToolView,

    'create-file': FileOperationToolView,
    'delete-file': FileOperationToolView,
    'full-file-rewrite': FileOperationToolView,
    'read-file': FileOperationToolView,
    'str-replace': StrReplaceToolView,
    'execute-command': CommandToolView,
    'terminate-command': TerminateCommandToolView,


    'load-image': SeeImageToolView,

    'expose-port': ExposePortToolView,
    'get-data-provider-endpoints': DataProviderEndpointsToolView,
    'execute-data-provider-call': ExecuteDataProviderCallToolView,



    'web-search': WebSearchToolView,
    'crawl-webpage': WebCrawlToolView,
    'deploy': DeployToolView,
    'scrape-webpage': WebScrapeToolView,

};

class ToolViewRegistry {
    private registry: Record<string, ToolViewComponent>;

    constructor(initialRegistry: Record<string, ToolViewComponent> = {}) {
        this.registry = { ...defaultRegistry, ...initialRegistry };
    }

    register(toolName: string, component: ToolViewComponent): void {
        this.registry[toolName] = component;
    }

    get(toolName: string): ToolViewComponent {
        return this.registry[toolName] || this.registry['default'];
    }

    has(toolName: string): boolean {
        return toolName in this.registry;
    }
}

export const toolViewRegistry = new ToolViewRegistry();

export function ToolView({ name = 'default', ...props }: ToolViewProps) {
    const ToolViewComponent = toolViewRegistry.get(name);

    return (
        <ToolViewProvider>
            <View style={{ flex: 1 }}>
                <ToolHeader
                    toolName={name}
                    isStreaming={props.isStreaming}
                    isSuccess={props.isSuccess}
                />
                <ToolViewComponent name={name} {...props} />
            </View>
        </ToolViewProvider>
    );
} 