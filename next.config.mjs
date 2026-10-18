/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // pdfjs-dist optionally requires the native `canvas` package; the browser build doesn't need it
    config.resolve.alias.canvas = false;
    return config;
  },
};
export default nextConfig;
