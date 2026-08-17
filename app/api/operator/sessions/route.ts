import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashSecret, generatePairingToken, generateSessionId } from '@/lib/auth';
import { logAuditEvent } from '@/lib/audit';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey } = body;
    const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';

    if (!apiKey || typeof apiKey !== 'string' || !apiKey.startsWith('rs_live_')) {
      return NextResponse.json({ error: 'Valid operator API key required' }, { status: 401 });
    }

    const keyHash = hashSecret(apiKey);
    const keyRecord = await prisma.apiKey.findUnique({
      where: { keyHash },
    });

    if (!keyRecord || keyRecord.revokedAt) {
      return NextResponse.json({ error: 'API key is invalid or revoked' }, { status: 401 });
    }

    const sessionId = generateSessionId();
    const { rawToken, tokenHash } = generatePairingToken();

    // 15-minute expiration timestamp
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const session = await prisma.session.create({
      data: {
        id: sessionId,
        apiKeyId: keyRecord.id,
        pairingTokenHash: tokenHash,
        status: 'WAITING',
        expiresAt,
      },
    });

    // Derive production pairing base URL
    // Priority: PUBLIC_APP_URL env var > request host header
    let baseUrl = process.env.PUBLIC_APP_URL;
    if (!baseUrl || baseUrl === 'https://support.example.com') {
      const host = req.headers.get('host') || 'localhost:3000';
      const protocol = req.headers.get('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
      baseUrl = `${protocol}://${host}`;
    }

    // Ensure no trailing slash
    baseUrl = baseUrl.replace(/\/$/, '');

    // Temporary pairing URL - NEVER contains API key!
    const pairingUrl = `${baseUrl}/pair/${sessionId}?token=${rawToken}`;

    await logAuditEvent({
      action: 'SESSION_CREATED',
      actorType: 'OPERATOR',
      details: { sessionId, keyPrefix: keyRecord.keyPrefix, expiresAt },
      ipAddress: ip,
      sessionId,
    });

    return NextResponse.json({
      success: true,
      session: {
        id: session.id,
        expiresAt: session.expiresAt.toISOString(),
        status: session.status,
        pairingUrl,
        rawToken, // Provided to operator dashboard to initiate WebRTC session room
      },
    });
  } catch (error) {
    console.error('Session creation error:', error);
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 });
  }
}
