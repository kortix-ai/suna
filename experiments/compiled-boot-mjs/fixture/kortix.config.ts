export default {
  agent: {
    name: "compiled-boot-demo",
    model: "demo/local",
    instructions: "Answer clearly and keep replies short.",
  },
  runtime: {
    version: "v1",
    healthy: true,
  },
  routes: {
    health: "/health",
    config: "/config",
    stream: "/stream",
  },
} as const;
