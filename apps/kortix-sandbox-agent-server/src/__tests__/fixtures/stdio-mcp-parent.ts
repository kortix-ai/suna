import { StdioMcpPool } from '../../stdio-mcp';
const [cwd, lock] = process.argv.slice(2);
const pool = new StdioMcpPool({ cwd: cwd!, historyLock: lock });
const configuration = {
  type: 'local' as const,
  command: [process.execPath, `${import.meta.dir}/stdio-mcp-server.mjs`],
};
const { connectionId } = await pool.request({
  server: 'fixture',
  configuration,
  method: 'tools/list',
});
const response = await pool.request({
  server: 'fixture',
  configuration,
  connectionId,
  method: 'tools/call',
  params: { name: 'grandchild' },
});
await Bun.write(`${cwd}/ready.json`, response.result.content[0].text);
setInterval(() => {}, 1000);
