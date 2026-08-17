import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logAuditEvent } from '@/lib/audit';

export async function POST(req: NextRequest, { params }: { params: { sessionId: string } }) {
  const { sessionId } = params;
  const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    if (session.status === 'ENDED') {
      return NextResponse.json({ message: 'Session is already ended', session });
    }

    const updated = await prisma.session.update({
      where: { id: sessionId },
      data: {
        status: 'ENDED',
        endedAt: new Date(),
      },
    });

    await logAuditEvent({
      action: 'SESSION_STOPPED_BY_OPERATOR',
      actorType: 'OPERATOR',
      details: { sessionId },
      ipAddress: ip,
      sessionId,
    });

    return NextResponse.json({
      success: true,
      message: 'Session terminated',
      session: updated,
    });
  } catch (error) {
    console.error('Failed to stop session:', error);
    return NextResponse.json({ error: 'Failed to stop session' }, { status: 500 });
  }
}
