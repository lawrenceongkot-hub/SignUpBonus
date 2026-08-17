import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticateAdminRequest, generateSecureApiKey } from '@/lib/auth';
import { logAuditEvent } from '@/lib/audit';

export async function GET(req: NextRequest) {
  const isAdmin = await authenticateAdminRequest();
  if (!isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const keys = await prisma.apiKey.findMany({
      select: {
        id: true,
        keyPrefix: true,
        label: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
        _count: {
          select: { sessions: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ keys });
  } catch (error) {
    console.error('Failed to list API keys:', error);
    return NextResponse.json({ error: 'Database operation failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const isAdmin = await authenticateAdminRequest();
  if (!isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';

  try {
    const body = await req.json().catch(() => ({}));
    const label = body.label?.trim() || `Support Key - ${new Date().toLocaleDateString()}`;

    // Cryptographically secure generation (never Math.random())
    const { rawKey, keyHash, keyPrefix } = generateSecureApiKey();

    const createdKey = await prisma.apiKey.create({
      data: {
        keyHash,
        keyPrefix,
        label,
      },
    });

    await logAuditEvent({
      action: 'API_KEY_GENERATED',
      actorType: 'ADMIN',
      details: { keyId: createdKey.id, keyPrefix, label },
      ipAddress: ip,
    });

    return NextResponse.json({
      success: true,
      apiKey: {
        id: createdKey.id,
        rawKey, // Returned ONLY once upon creation!
        keyPrefix,
        label,
        createdAt: createdKey.createdAt,
      },
    });
  } catch (error) {
    console.error('Failed to generate API key:', error);
    return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 });
  }
}
