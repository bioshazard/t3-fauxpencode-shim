import { defineConfig } from "oxlint";

const ignorePatterns = ["node_modules/**", "coverage/**", "artifacts/**"];

export default defineConfig({
  ignorePatterns,
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "import/no-default-export": "error",
    "import/no-named-export": "off",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-runtime-typeof": "error",
  },
});
