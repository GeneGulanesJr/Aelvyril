import type { NextConfig } from "next";

export default {
  transpilePackages: ["@aelvyril/shared"],
  // The repo uses Node-style ".js"-extension relative imports in TS sources
  // (lib/api.ts -> ./sse.js; @aelvyril/shared barrel -> ./envelope.js).
  // tsc (moduleResolution "bundler") and vite resolve these to ".ts" files,
  // but webpack needs an explicit extensionAlias to do the same.
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
} satisfies NextConfig;
