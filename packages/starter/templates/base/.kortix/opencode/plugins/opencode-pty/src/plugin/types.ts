import type { Plugin } from '../../../../tools/lib/tool'

export type PluginClient = Parameters<Plugin>[0]['client']

export type PluginContext = Parameters<Plugin>[0]

export type PluginResult = Awaited<ReturnType<Plugin>>
