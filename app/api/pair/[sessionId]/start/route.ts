import { NextRequest, NextResponse } from 'next/server';
import { prisma, ensureDatabaseInitialized } from '@/lib/prisma';
import { hashSecret } from '@/lib/auth';
import { getWebRtcConfiguration } from '@/lib/webrtc-config';
import { logAuditEvent } from '@/lib/audit';

export async function POST(req: NextRequest, { params }: { params: { sessionId: string } }) {
  const { sessionId } = params;
  const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';

  try {
    const body = await req.json();
    const { token, userAgent, platform, screenResolution } = body;

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Pairing token is required' }, { status: 400 });
    }

    await ensureDatabaseInitialized();

    const tokenHash = hashSecret(token);

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session || session.pairingTokenHash !== tokenHash) {
      return NextResponse.json({ error: 'Invalid session or token' }, { status: 401 });
    }

    if (session.status === 'ENDED' || session.expiresAt < new Date()) {
      return NextResponse.json({ error: 'Session is expired or ended' }, { status: 410 });
    }

    // Record connected device info
    await prisma.device.create({
      data: {
        sessionId,
        userAgent: userAgent || req.headers.get('user-agent') || 'Unknown',
        platform: platform || 'Android / Web',
        screenResolution: screenResolution || 'Unknown',
        ipAddress: ip,
      },
    });

    // Update session state
    const updated = await prisma.session.update({
      where: { id: sessionId },
      data: {
        status: 'SCREEN_SHARING',
        startedAt: session.startedAt || new Date(),
      },
    });

    await logAuditEvent({
      action: 'SESSION_PAIRING_AUTHORIZED',
      actorType: 'DEVICE',
      details: { sessionId, platform, screenResolution },
      ipAddress: ip,
      sessionId,
    });

    const rtcConfig = getWebRtcConfiguration();

    return NextResponse.json({
      success: true,
      status: updated.status,
      rtcConfig,
    });
  } catch (error: any) {
    console.error('Failed to start session:', error);
    return NextResponse.json({ error: 'Failed to start session: ' + (error?.message || 'Database error') }, { status: 500 });
  }
}
