import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  // @google/adk hace requires opcionales (telemetría GCP) que Turbopack no puede
  // resolver al bundlear; se deja como paquete externo del servidor.
  // @crawlee/cheerio igual: bundleado en el chunk SSR, su _getStorageClientFactories
  // revienta con "Cannot read properties of undefined (reading 'bind')"
  // (2026-10-21: prospect OK en local/dev y en worker tsx, KO en server standalone).
  serverExternalPackages: ["@google/adk", "@crawlee/cheerio"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
