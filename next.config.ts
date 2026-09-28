import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Photos go through server actions now (HEIC conversion, platform upload),
     and a phone photo is several times the 1 MB default. */
  experimental: {
    serverActions: { bodySizeLimit: "45mb" },
  },
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
