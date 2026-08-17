import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/auth';
import { logAuditEvent } from '@/lib/audit';

export async function POST(req: NextRequest, { params }: { params: { keyId: string } }) {
  const isAdmin = await authenticateAdminRequest();
  if (!isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { keyId } = params;
  const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';

  try {
    const existing = await prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!existing) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 });
    }

    if (existing.revokedAt) {
      return NextResponse.json({ message: 'Key is already revoked', apiKey: existing });
    }

    const updated = await prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });

    await logAuditEvent({
      action: 'API_KEY_REVOKED',
      actorType: 'ADMIN',
      details: { keyId, keyPrefix: updated.keyPrefix },
      ipAddress: ip,
    });

    return NextResponse.json({ success: true, message: 'API key revoked', apiKey: updated });
  } catch (error) {
    console.error('Failed to revoke API key:', error);
    return NextResponse.json({ error: 'Failed to revoke API key' }, { status: 500 });
  }
}
