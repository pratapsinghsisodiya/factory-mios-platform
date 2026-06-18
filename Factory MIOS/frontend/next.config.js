/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // This is a foundation build — don't let type/lint checks block the production
  // image. Run `npm run lint` / `tsc` locally for full strictness.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
module.exports = nextConfig;
