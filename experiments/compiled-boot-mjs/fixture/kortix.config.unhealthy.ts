export default {
  agent: {
    name: "compiled-boot-demo",
    model: "demo/local",
    instructions: "This candidate must not be promoted.",
  },
  runtime: {
    version: "broken",
    healthy: false,
  },
  routes: {
    health: "/health",
    config: "/config",
    stream: "/stream",
  },
} as const;
