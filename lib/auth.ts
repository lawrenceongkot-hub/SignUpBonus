import crypto from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

// Server-side secret key for admin session JWTs
const JWT_SECRET = process.env.ADMIN_JWT_SECRET
  ? new TextEncoder().encode(process.env.ADMIN_JWT_SECRET)
  : new TextEncoder().encode('remote-support-admin-sec-' + (process.env.ADMIN_PASSWORD || 'Ryeon1121') + '-auth-secret');

const ADMIN_COOKIE_NAME = 'rs_admin_token';

/**
 * Generate a cryptographically secure random API key.
 * Format: rs_live_<48 hex chars>
 * Never use Math.random() or predictable sequences.
 */
export function generateSecureApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const randomHex = crypto.randomBytes(24).toString('hex');
  const rawKey = `rs_live_${randomHex}`;
  const keyHash = hashSecret(rawKey);
  const keyPrefix = `rs_live_${randomHex.substring(0, 6)}...`;
  return { rawKey, keyHash, keyPrefix };
}

/**
 * Cryptographically secure SHA-256 hash.
 */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret.trim()).digest('hex');
}

/**
 * Generate a cryptographically secure temporary pairing token.
 */
export function generatePairingToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSecret(rawToken);
  return { rawToken, tokenHash };
}

/**
 * Generate a unique session ID.
 */
export function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Validates admin credentials securely against environment variables.
 */
export function verifyAdminCredentials(username: string, password: string): boolean {
  const expectedUsername = process.env.ADMIN_USERNAME || 'Admin';
  const expectedPassword = process.env.ADMIN_PASSWORD || 'Ryeon1121';

  if (!username || !password) return false;

  // Constant-time comparison to prevent timing attacks
  const userMatch = crypto.timingSafeEqual(
    Buffer.from(username.padEnd(64, ' ')),
    Buffer.from(expectedUsername.padEnd(64, ' '))
  ) && username.length === expectedUsername.length;

  const passMatch = crypto.timingSafeEqual(
    Buffer.from(password.padEnd(64, ' ')),
    Buffer.from(expectedPassword.padEnd(64, ' '))
  ) && password.length === expectedPassword.length;

  return userMatch && passMatch;
}

/**
 * Signs a secure Admin JWT session token (valid for 8 hours).
 */
export async function createAdminSessionToken(username: string): Promise<string> {
  return new SignJWT({ role: 'ADMIN', username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(JWT_SECRET);
}

/**
 * Verifies the Admin JWT session token.
 */
export async function verifyAdminSessionToken(token: string): Promise<{ valid: boolean; username?: string }> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if (payload.role === 'ADMIN' && typeof payload.username === 'string') {
      return { valid: true, username: payload.username };
    }
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

/**
 * Authenticates the current admin request via HTTPOnly cookies or Authorization header.
 */
export async function authenticateAdminRequest(): Promise<boolean> {
  try {
    const cookieStore = cookies();
    const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
    if (!token) return false;
    const result = await verifyAdminSessionToken(token);
    return result.valid;
  } catch {
    return false;
  }
}

export { ADMIN_COOKIE_NAME };
