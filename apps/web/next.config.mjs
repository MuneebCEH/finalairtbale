/** @type {import('next').NextConfig} */

// STATIC_EXPORT=1 produces a fully static site (out/) that runs on any host — including cPanel —
// with no Node server. The dev server and the container build keep using `standalone`.
const isExport = process.env.STATIC_EXPORT === '1';

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // `next dev` and `next build` cannot share a build directory: the dev server holds file
  // handles in `.next` and the production build clears it. A separate dir lets the build run
  // while a dev server is up.
  distDir: process.env.NEXT_BUILD_DIR ?? '.next',

  output: isExport ? 'export' : 'standalone',

  // Workspace TypeScript packages are transpiled by Next rather than pre-built.
  transpilePackages: ['@tessera/types', '@tessera/validation'],

  experimental: {
    // typedRoutes hard-fails the build on any link to an unbuilt route (e.g. the Settings link);
    // it's only a DX aid, so the static export skips it. Routes resolve fine at runtime.
    typedRoutes: !isExport,
  },

  // A static export has no image optimizer, so images are served as-is.
  ...(isExport ? { images: { unoptimized: true }, trailingSlash: true } : {}),

  // `headers()` needs a server; a static export can't set them (the cPanel .htaccess does instead).
  ...(isExport
    ? {}
    : {
        async headers() {
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
      }),
};

export default nextConfig;
