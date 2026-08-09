/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // `next dev` and `next build` cannot share a build directory: the dev server holds file
  // handles in `.next` and the production build clears it, so running the two together hangs or
  // corrupts one of them. Giving the build its own directory means `npm run build` works while a
  // dev server is up — which it always is when somebody is about to run the build.
  distDir: process.env.NEXT_BUILD_DIR ?? '.next',
  // Standalone output produces a self-contained server bundle, which keeps the runtime container
  // image small and free of the package manager and build toolchain.
  output: 'standalone',
  experimental: {
    typedRoutes: true,
  },
  async headers() {
    // These duplicate the edge/ingress configuration deliberately. Defence in depth: the app is
    // safe even if it is deployed behind a proxy that was not configured as documented.
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'geolocation=(), camera=(), microphone=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
