import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "src/db/migrations/**", "src/db/auth-schema.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
