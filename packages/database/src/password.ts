import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const options = { N: 65536, r: 8, p: 2, maxmem: 96 * 1024 * 1024 };
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 256)
    throw new Error('Password must be at least 12 characters and at most 256 UTF-8 bytes.');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `scrypt$65536$8$2$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$65536$8$2') return false;
  const salt = parts[4] ?? '';
  const expected = parts[5] ?? '';
  if (!/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expected)) return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
