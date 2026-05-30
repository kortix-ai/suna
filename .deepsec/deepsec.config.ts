import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    { id: "suna", root: ".." },
    // <deepsec:projects-insert-above>
  ],
});
