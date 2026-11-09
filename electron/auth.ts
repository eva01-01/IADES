import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';

const deriveKey = (password: string, salt: Buffer, length: number) => new Promise<Buffer>((resolve, reject) => {
  scryptCallback(password, salt, length, scryptOptions, (error, key) => error ? reject(error) : resolve(key as Buffer));
});
const saltBytes = 16;
const keyBytes = 64;
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function normalizeEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function validateAccountInput(emailValue: unknown, passwordValue: unknown) {
  const email = normalizeEmail(emailValue);
  const password = typeof passwordValue === 'string' ? passwordValue : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (password.length < 12 || password.length > 128) throw new Error('Use a password between 12 and 128 characters.');
  return { email, password };
}

export async function hashPassword(password: string) {
  const salt = randomBytes(saltBytes);
  const key = await deriveKey(password, salt, keyBytes);
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, cost, blockSize, parallelization, saltValue, keyValue] = encoded.split('$');
  if (algorithm !== 'scrypt' || cost !== '32768' || blockSize !== '8' || parallelization !== '1' || !saltValue || !keyValue) return false;
  try {
    const salt = Buffer.from(saltValue, 'base64url');
    const expected = Buffer.from(keyValue, 'base64url');
    if (salt.length !== saltBytes || expected.length !== keyBytes) return false;
    const actual = await deriveKey(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
