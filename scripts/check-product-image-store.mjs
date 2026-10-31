// Read-only local consistency inventory; uploads in progress can appear as transient orphans.
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabase } from '../packages/database/dist/index.js';
const url = new URL(process.env.DATABASE_URL ?? '');
if (
  process.env.NODE_ENV === 'production' ||
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/yumi_dev' ||
  url.searchParams.has('schema')
)
  throw Error('Only local yumi_dev/public is supported.');
const db = createDatabase(url.toString());
try {
  const directory = resolve(process.env.PRODUCT_IMAGE_LOCAL_DIR || '.local/product-images');
  const images = await db.productImage.findMany({ select: { objectKey: true } });
  const files = await readdir(directory).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  const known = new Set(images.map((image) => image.objectKey));
  console.log(
    JSON.stringify(
      {
        readOnly: true,
        metadataCount: images.length,
        missing: images
          .filter((image) => !files.includes(image.objectKey))
          .map((image) => image.objectKey),
        unreferenced: files.filter((file) => /^[a-f0-9-]{36}\.png$/.test(file) && !known.has(file)),
        note: 'No deletion. In-flight writes can appear unreferenced; investigate before cleanup.',
      },
      null,
      2,
    ),
  );
} finally {
  await db.$disconnect();
}
