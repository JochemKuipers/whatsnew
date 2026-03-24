import { defineConfig } from "@spicemod/creator";
import { resolve } from "path";

// Learn more: https://github.com/sanoojes/spicetify-creator
export default defineConfig({
  name: "whatsnew",
  framework: "react",
  linter: "biome",
  template: "extension",
  packageManager: "bun",
  esbuildOptions: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
