import { copyFileSync, cpSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  outDir: "dist",
  target: "node20",
  clean: true,
  sourcemap: true,
  onSuccess: async () => {
    copyFileSync(
      "src/projects/stack/compose.base.yml",
      "dist/compose.base.yml",
    );
    cpSync("src/projects/stack/volumes", "dist/volumes", { recursive: true });
  },
});
