/** @type {import('next').NextConfig} */
const nextConfig = {
  // Output standalone build for efficient Railway deployment
  output: "standalone",

  // Silence Webpack warnings about pg (uses optional native bindings)
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals ?? []), "pg-native"];
    }
    return config;
  },

  // Environment variables exposed to the server only (never sent to the browser)
  // These are set in Railway's environment variable panel, not here.
  // Listed for documentation purposes:
  //   DATABASE_URL      - Railway Postgres connection string
  //   GEMINI_API_KEY    - Google AI Studio API key
  //   INGEST_ON_DEPLOY  - Set to "true" to run ingestion on next deploy
};

module.exports = nextConfig;
