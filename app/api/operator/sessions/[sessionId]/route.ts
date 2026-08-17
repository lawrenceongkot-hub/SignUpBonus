import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest, { params }: { params: { sessionId: string } }) {
  const { sessionId } = params;

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        devices: {
          orderBy: { connectedAt: 'desc' },
          take: 1,
        },
        apiKey: {
          select: { label: true, keyPrefix: true },
        },
      },
    });

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json({
      session: {
        id: session.id,
        status: session.status,
        expiresAt: session.expiresAt.toISOString(),
        startedAt: session.startedAt?.toISOString() || null,
        endedAt: session.endedAt?.toISOString() || null,
        device: session.devices[0] || null,
        operatorLabel: session.apiKey?.label || 'Support Operator',
      },
    });
  } catch (error) {
    console.error('Failed to get session:', error);
    return NextResponse.json({ error: 'Failed to retrieve session' }, { status: 500 });
  }
}
