import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next*/**",
      "**/coverage/**",
      "**/artifacts/**",
      "**/.artifacts/**",
      "**/next-env.d.ts",
    ],
  },
  {
    files: ["**/*.{ts,mjs,js}"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      ...js.configs.recommended.rules,
      // TypeScript handles symbol/scope validation; catch blocks intentionally tolerate offline peers.
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];
