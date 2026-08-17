import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminCredentials, createAdminSessionToken, ADMIN_COOKIE_NAME } from '@/lib/auth';
import { logAuditEvent } from '@/lib/audit';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { username, password } = body;

    const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';

    if (!username || !password) {
      await logAuditEvent({
        action: 'ADMIN_LOGIN_FAILED',
        actorType: 'ADMIN',
        details: { reason: 'Missing username or password' },
        ipAddress: ip,
      });
      return NextResponse.json({ error: 'Username and password are required' }, { status: 400 });
    }

    const isValid = verifyAdminCredentials(username, password);

    if (!isValid) {
      await logAuditEvent({
        action: 'ADMIN_LOGIN_FAILED',
        actorType: 'ADMIN',
        actorId: username,
        details: { reason: 'Invalid credentials' },
        ipAddress: ip,
      });
      return NextResponse.json({ error: 'Invalid administrator credentials' }, { status: 401 });
    }

    const token = await createAdminSessionToken(username);

    await logAuditEvent({
      action: 'ADMIN_LOGIN_SUCCESS',
      actorType: 'ADMIN',
      actorId: username,
      ipAddress: ip,
    });

    const response = NextResponse.json({ success: true, message: 'Authenticated successfully' });

    // Set secure HTTP-only cookie
    response.cookies.set(ADMIN_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 8 * 60 * 60, // 8 hours
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Admin login error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
