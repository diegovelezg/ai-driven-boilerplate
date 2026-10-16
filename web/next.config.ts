import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // @google/adk hace requires opcionales (telemetría GCP) que Turbopack no puede
  // resolver al bundlear; se deja como paquete externo del servidor.
  serverExternalPackages: ["@google/adk"],
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
