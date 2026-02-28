import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["playwright"],
  devIndicators: false,
};

export default nextConfig;
