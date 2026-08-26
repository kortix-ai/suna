export default {
  agent: {
    name: "compiled-boot-demo",
    model: "demo/local",
    instructions: "Answer clearly and include one concrete next action.",
  },
  runtime: {
    version: "v2",
    healthy: true,
  },
  routes: {
    health: "/health",
    config: "/config",
    stream: "/stream",
  },
} as const;
