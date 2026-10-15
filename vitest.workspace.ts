import { defineWorkspace } from "vitest/config";
export default defineWorkspace([
  { test: { include: ["packages/**/*.test.ts"], globals: false } },
]);
