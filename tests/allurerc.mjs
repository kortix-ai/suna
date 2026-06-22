import { defineConfig } from "allure";

export default defineConfig({
  name: "ke2e — Kortix E2E",
  output: "./test-results/allure-report",
  historyPath: "./test-results/history.jsonl",
  plugins: {
    awesome: {
      options: {
        reportName: "ke2e — Kortix E2E",
        singleFile: true,
        theme: "light",
        groupBy: ["epic", "story"],
        stepTreeExpansion: "expanded",
        defaultSortBy: "status,asc",
      },
    },
  },
});
