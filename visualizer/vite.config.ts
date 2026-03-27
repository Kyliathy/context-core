import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getApiPort(): number {
	const portFile = resolve(__dirname, "../server/.cxc-port");
	if (existsSync(portFile)) {
		const port = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
		if (port > 0) return port;
	}
	return 3210;
}

export default defineConfig({
	plugins: [
		react(),
		VitePWA({
			registerType: "prompt",
			devOptions: { enabled: true, suppressWarnings: true },
			manifest: {
				name: "ContextCore Visualizer",
				short_name: "CXC Viz",
				description: "AI conversation history explorer — search, browse, and build agents from multi-IDE chat archives",
				start_url: "/",
				display: "standalone",
				display_override: ["window-controls-overlay", "standalone"],
				background_color: "#0a0a0f",
				theme_color: "#0a0a0f",
				icons: [
					{ src: "/pwa/icon-192x192.png", sizes: "192x192", type: "image/png" },
					{ src: "/pwa/icon-512x512.png", sizes: "512x512", type: "image/png" },
					{ src: "/pwa/icon-maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
				],
			},
			workbox: {
				navigateFallback: "/index.html",
				runtimeCaching: [
					{
						urlPattern: /\/api\/search/,
						handler: "NetworkFirst",
						options: {
							cacheName: "api-search-cache",
							networkTimeoutSeconds: 5,
							expiration: { maxEntries: 50, maxAgeSeconds: 3600 },
						},
					},
					{
						urlPattern: /\/api\/(sessions|threads|messages)/,
						handler: "NetworkFirst",
						options: {
							cacheName: "api-data-cache",
							networkTimeoutSeconds: 5,
							expiration: { maxEntries: 100, maxAgeSeconds: 7200 },
						},
					},
					{
						urlPattern: /\/api\/projects/,
						handler: "StaleWhileRevalidate",
						options: {
							cacheName: "api-meta-cache",
							expiration: { maxEntries: 10, maxAgeSeconds: 86400 },
						},
					},
					{
						urlPattern: /\/api\/agent-builder\//,
						handler: "NetworkFirst",
						options: {
							cacheName: "api-agent-cache",
							networkTimeoutSeconds: 5,
							expiration: { maxEntries: 30, maxAgeSeconds: 3600 },
						},
					},
				],
			},
		}),
	],
	server: {
		port: 5173,
		proxy: {
			"/api": { target: `http://localhost:${getApiPort()}`, changeOrigin: true },
		},
	},
});