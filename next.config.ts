import type { NextConfig } from "next";

/*
 * Static export for GitHub Pages (or any static host). There is no server:
 * all data is read and processed in the browser from files the user selects.
 * PAGES_BASE_PATH is set by the GitHub Actions workflow to "/<repo-name>".
 */
const basePath = process.env.PAGES_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
