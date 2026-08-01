/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `pg` and `nodemailer` are server-only and must not be bundled.
  // Next 14 spells this under `experimental`; it graduates to a top-level
  // `serverExternalPackages` in Next 15 — rename it if this ever upgrades.
  experimental: {
    serverComponentsExternalPackages: ['pg', 'nodemailer'],
  },
};

export default nextConfig;
