import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashSecret } from '@/lib/auth';
import { logAuditEvent } from '@/lib/audit';

export async function POST(req: NextRequest, { params }: { params: { sessionId: string } }) {
  const { sessionId } = params;
  const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';

  try {
    const body = await req.json();
    const { token } = body;

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Pairing token is required' }, { status: 400 });
    }

    const tokenHash = hashSecret(token);

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        apiKey: {
          select: { label: true },
        },
      },
    });

    if (!session) {
      await logAuditEvent({
        action: 'SESSION_PAIRING_REJECTED',
        actorType: 'DEVICE',
        details: { reason: 'Session not found', sessionId },
        ipAddress: ip,
        sessionId,
      });
      return NextResponse.json({ error: 'Invalid or non-existent session' }, { status: 404 });
    }

    if (session.pairingTokenHash !== tokenHash) {
      await logAuditEvent({
        action: 'SESSION_PAIRING_REJECTED',
        actorType: 'DEVICE',
        details: { reason: 'Token hash mismatch', sessionId },
        ipAddress: ip,
        sessionId,
      });
      return NextResponse.json({ error: 'Invalid pairing token' }, { status: 401 });
    }

    if (session.status === 'ENDED') {
      return NextResponse.json({ error: 'This remote support session has already ended' }, { status: 410 });
    }

    if (session.expiresAt < new Date()) {
      await prisma.session.update({
        where: { id: sessionId },
        data: { status: 'ENDED' },
      });
      return NextResponse.json({ error: 'This pairing session has expired' }, { status: 410 });
    }

    await logAuditEvent({
      action: 'SESSION_PAIRING_ATTEMPT',
      actorType: 'DEVICE',
      details: { sessionId },
      ipAddress: ip,
      sessionId,
    });

    return NextResponse.json({
      valid: true,
      sessionId: session.id,
      operatorName: session.apiKey?.label || 'Support Operator',
      status: session.status,
      expiresAt: session.expiresAt.toISOString(),
    });
  } catch (error) {
    console.error('Pairing verification error:', error);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}
