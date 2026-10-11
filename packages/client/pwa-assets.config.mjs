// The app's icons, generated once from public/icon.svg (already full-bleed and
// maskable-safe, so no padding) and committed:
//   npx @vite-pwa/assets-generator@2.0.0   (from packages/client, in node:22-alpine)
export default {
  preset: {
    transparent: { sizes: [64, 192, 512], favicons: [[48, "favicon.ico"]], padding: 0 },
    maskable: { sizes: [512], padding: 0 },
    apple: { sizes: [180], padding: 0 },
  },
  images: ["public/icon.svg"],
};
