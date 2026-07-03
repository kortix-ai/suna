import { defineConfig, type DeepsecPlugin } from "deepsec/config";
import { kortixHonoEntrypoint } from "./matchers/kortix-hono-entrypoint.js";
import { kortixTerraformIacSurface } from "./matchers/kortix-terraform-iac-surface.js";

const kortixPlugin: DeepsecPlugin = {
  name: "kortix-security-surfaces",
  matchers: [kortixHonoEntrypoint, kortixTerraformIacSurface],
};

export default defineConfig({
  projects: [
    { id: "suna", root: ".." },
    // <deepsec:projects-insert-above>
  ],
  plugins: [kortixPlugin],
});
