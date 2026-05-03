import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // We render avatars from arbitrary Bluesky and Mastodon hosts (every
      // Mastodon instance is a different domain) plus blob: URLs from
      // client-side image compression. next/image's optimization pipeline
      // doesn't fit that — plain <img> is the right call here.
      "@next/next/no-img-element": "off",
    },
  },
]);

export default eslintConfig;
