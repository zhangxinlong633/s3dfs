/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // TypeScript 7 has no lib/typescript.js; Next 16 typechecks via tsc.
    useTypeScriptCli: true,
  },
  env: {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:9000',
  },
};

export default nextConfig;
