import { definePiAgent, type PiStdioMcpServer } from '@kortix/sdk/pi';

const files: PiStdioMcpServer = {
  type: 'local',
  command: ['node', '/opt/kortix/helpers/files.mjs'],
  cwd: '/workspace',
  environment: { API_TOKEN: '{env:MCP_TOKEN}' },
  timeout: 30000,
};

export default definePiAgent(() => ({ mcp: { files } }));
