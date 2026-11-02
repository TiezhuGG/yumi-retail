// Loopback preview of built admin/operations assets; not a production server.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from '../apps/admin-web/node_modules/vite/dist/node/index.js';
if (process.argv.slice(2).some((a) => a !== '--ops')) throw Error('Only --ops is supported');
const ops = process.argv.includes('--ops'),
  root = resolve(ops ? 'apps/ops-mobile/dist' : 'apps/admin-web/dist');
if (!existsSync(root + '/index.html')) throw Error('Build the web application before preview');
const server = await createServer({
  configFile: false,
  root,
  plugins: [],
  optimizeDeps: { noDiscovery: true },
  server: {
    host: '127.0.0.1',
    port: ops ? 5174 : 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
await server.listen();
console.log(`Local built preview: http://127.0.0.1:${ops ? 5174 : 5173}/ (API loopback3000)`);
process.on('SIGINT', async () => {
  await server.close();
  process.exitCode = 0;
});
