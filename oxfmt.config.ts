import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    "node_modules/**",
    "coverage/**",
    "artifacts/**",
    "dist/**",
  ],
});
