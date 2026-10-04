import type { NextConfig } from "next";

// Hosted demo: the agent API and the fork RPC run on a VPS. When AGENT_ORIGIN is set, this
// deployment proxies them (/agent/* and /rpc), so every public URL stays on the dashboard's
// own domain and the browser never needs CORS. Rewrites are resolved at build time.
const agentOrigin = process.env.AGENT_ORIGIN?.trim().replace(/\/+$/, "");
if (agentOrigin && !/^https?:\/\/[^/\s]+$/.test(agentOrigin)) {
  throw new Error(`AGENT_ORIGIN must be a bare origin such as https://host, got "${agentOrigin}"`);
}

const nextConfig: NextConfig = {
  reactCompiler: true,
  async rewrites() {
    if (!agentOrigin) return [];
    return [
      { source: "/agent/:path*", destination: `${agentOrigin}/:path*` },
      { source: "/rpc", destination: `${agentOrigin}/rpc` },
    ];
  },
};

export default nextConfig;
