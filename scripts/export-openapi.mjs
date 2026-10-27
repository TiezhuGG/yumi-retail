import { mkdir, writeFile } from 'node:fs/promises';
import { createApplication } from '../apps/api/dist/app.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const runtime = await createApplication(process.env.DATABASE_URL, { accessLog: () => {} });
try {
  await mkdir('docs/api', { recursive: true });
  await writeFile('docs/api/openapi.json', JSON.stringify(runtime.openApi, null, 2) + '\n');
  console.log('Exported the implemented API contract to docs/api/openapi.json.');
} finally {
  await runtime.close();
}
