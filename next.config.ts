import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray lockfile in the home directory makes Next mis-infer the workspace root.
  turbopack: { root: __dirname },
  env: {
    // Build stamp shown in the Account screen — tells us which version a device runs.
    NEXT_PUBLIC_BUILD: new Date().toISOString().slice(0, 16).replace('T', ' '),
  },
};

export default nextConfig;
