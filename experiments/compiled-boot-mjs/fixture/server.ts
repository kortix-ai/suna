import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import config from "./kortix.config.ts";

const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");

  if (request.url === config.routes.health) {
    response.statusCode = config.runtime.healthy ? 200 : 503;
    response.end(
      JSON.stringify({
        status: config.runtime.healthy ? "ok" : "error",
        agent: config.agent.name,
        version: config.runtime.version,
      }),
    );
    return;
  }

  if (request.url === config.routes.config) {
    response.end(JSON.stringify(config));
    return;
  }

  if (request.url === config.routes.stream) {
    response.setHeader("content-type", "application/x-ndjson");
    response.write(`${JSON.stringify({ version: config.runtime.version })}\n`);
    const releaseFile = process.env.DEMO_STREAM_RELEASE_FILE;
    if (releaseFile) {
      const interval = setInterval(() => {
        if (!existsSync(releaseFile)) return;
        clearInterval(interval);
        response.end(`${JSON.stringify({ event: "complete" })}\n`);
      }, 5);
      response.once("close", () => clearInterval(interval));
    }
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  process.stdout.write(
    `${JSON.stringify({ event: "ready", port: address.port })}\n`,
  );
});

const stop = () => server.close(() => process.exit(0));

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
