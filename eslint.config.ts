import strictFp from "@mye-org/eslint-plugin-strict-fp";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "templates/**", "skills/**", "docs/**"],
  },
  ...strictFp.createStrictFpConfig({
    boundaryFiles: [
      "src/adapters/**/*.ts",
      "src/cli/**/*.ts",
      "src/interpreter/**/*.ts",
      "eslint.config.ts",
      "tsup.config.ts",
      "vitest.config.ts",
    ],
    testFiles: ["tests/**/*.ts"],
  }),
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.ts",
            "tsup.config.ts",
            "vitest.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
