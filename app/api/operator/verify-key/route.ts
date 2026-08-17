import { NextRequest, NextResponse } from 'next/server';
import { prisma, ensureDatabaseInitialized } from '@/lib/prisma';
import { hashSecret } from '@/lib/auth';
import { logAuditEvent } from '@/lib/audit';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey } = body;
    const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';

    if (!apiKey || typeof apiKey !== 'string' || !apiKey.startsWith('rs_live_')) {
      await logAuditEvent({
        action: 'OPERATOR_AUTH_FAILED',
        actorType: 'OPERATOR',
        details: { reason: 'Malformed API key format' },
        ipAddress: ip,
      });
      return NextResponse.json({ error: 'Invalid API key format. Expected rs_live_...' }, { status: 401 });
    }

    await ensureDatabaseInitialized();

    const keyHash = hashSecret(apiKey);

    const record = await prisma.apiKey.findUnique({
      where: { keyHash },
    });

    if (!record) {
      await logAuditEvent({
        action: 'OPERATOR_AUTH_FAILED',
        actorType: 'OPERATOR',
        details: { reason: 'Key not found in database' },
        ipAddress: ip,
      });
      return NextResponse.json({ error: 'Invalid or non-existent API key.' }, { status: 401 });
    }

    if (record.revokedAt) {
      await logAuditEvent({
        action: 'OPERATOR_AUTH_FAILED',
        actorType: 'OPERATOR',
        details: { reason: 'Key revoked', keyId: record.id },
        ipAddress: ip,
      });
      return NextResponse.json({ error: 'This API key has been revoked by an administrator.' }, { status: 401 });
    }

    if (record.expiresAt && record.expiresAt < new Date()) {
      await logAuditEvent({
        action: 'OPERATOR_AUTH_FAILED',
        actorType: 'OPERATOR',
        details: { reason: 'Key expired', keyId: record.id },
        ipAddress: ip,
      });
      return NextResponse.json({ error: 'This API key has expired.' }, { status: 401 });
    }

    // Update last used timestamp
    await prisma.apiKey.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    });

    await logAuditEvent({
      action: 'OPERATOR_AUTH_SUCCESS',
      actorType: 'OPERATOR',
      details: { keyId: record.id, keyPrefix: record.keyPrefix },
      ipAddress: ip,
    });

    return NextResponse.json({
      valid: true,
      keyPrefix: record.keyPrefix,
      label: record.label,
    });
  } catch (error: any) {
    console.error('Operator verify error:', error);
    return NextResponse.json({ error: 'Authentication failed: ' + (error?.message || 'Internal database error') }, { status: 500 });
  }
}
