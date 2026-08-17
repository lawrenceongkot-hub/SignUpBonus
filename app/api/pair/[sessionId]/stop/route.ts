import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashSecret } from '@/lib/auth';
import { logAuditEvent } from '@/lib/audit';

export async function POST(req: NextRequest, { params }: { params: { sessionId: string } }) {
  const { sessionId } = params;
  const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';

  try {
    const body = await req.json().catch(() => ({}));
    const { token } = body;

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    if (token) {
      const tokenHash = hashSecret(token);
      if (session.pairingTokenHash !== tokenHash) {
        return NextResponse.json({ error: 'Invalid pairing token' }, { status: 401 });
      }
    }

    const updated = await prisma.session.update({
      where: { id: sessionId },
      data: {
        status: 'ENDED',
        endedAt: new Date(),
      },
    });

    await logAuditEvent({
      action: 'SESSION_STOPPED_BY_USER',
      actorType: 'DEVICE',
      details: { sessionId },
      ipAddress: ip,
      sessionId,
    });

    return NextResponse.json({
      success: true,
      message: 'Remote support session stopped by user',
      session: updated,
    });
  } catch (error) {
    console.error('Failed to stop session from user device:', error);
    return NextResponse.json({ error: 'Failed to stop session' }, { status: 500 });
  }
}
