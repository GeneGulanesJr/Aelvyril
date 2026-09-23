import type { NextConfig } from "next";

export default {
  transpilePackages: ["@aelvyril/shared"],
  // The repo uses Node-style ".js"-extension relative imports in TS sources
  // (lib/api.ts -> ./sse.js; @aelvyril/shared barrel -> ./envelope.js).
  // tsc (moduleResolution "bundler") and vitest resolve these to ".ts" files,
  // but webpack needs an explicit extensionAlias to do the same.
  //
  // Next 16 defaults to Turbopack, which REJECTS a webpack config AND does
  // not implement .js -> .ts extension aliasing (verified: build fails with
  // "Can't resolve './sse.js'"). So we opt out of Turbopack with explicit
  // --webpack flags in the dev/build scripts. Revisit only if the .js-style
  // imports are ever migrated to extension-less specifiers.
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
} satisfies NextConfig;
