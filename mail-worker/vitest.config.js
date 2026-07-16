import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'cloudflare:workers': fileURLToPath(new URL('./test/mocks/cloudflare-workers.js', import.meta.url)),
		},
	},
	test: {
		environment: 'node',
	},
});
