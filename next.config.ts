import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["playwright", "better-sqlite3"],
  devIndicators: false,
};

export default nextConfig;
