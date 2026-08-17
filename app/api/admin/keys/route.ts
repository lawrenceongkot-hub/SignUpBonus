import { NextRequest, NextResponse } from 'next/server';
import { prisma, ensureDatabaseInitialized } from '@/lib/prisma';
import { authenticateAdminRequest, generateSecureApiKey } from '@/lib/auth';
import { logAuditEvent } from '@/lib/audit';

export async function GET(req: NextRequest) {
  const isAdmin = await authenticateAdminRequest();
  if (!isAdmin) {
    return NextResponse.json({ error: 'Unauthorized. Admin authentication required.' }, { status: 401 });
  }

  try {
    // Ensure DB tables exist
    await ensureDatabaseInitialized();

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
  } catch (error: any) {
    console.error('[API_KEYS GET ERROR]:', error);

    // If table was missing, attempt schema initialization and retry once
    if (error?.code === 'P2021' || error?.message?.includes('does not exist')) {
      try {
        await ensureDatabaseInitialized();
        const keys = await prisma.apiKey.findMany({
          select: {
            id: true,
            keyPrefix: true,
            label: true,
            createdAt: true,
            expiresAt: true,
            revokedAt: true,
            lastUsedAt: true,
          },
          orderBy: { createdAt: 'desc' },
        });
        return NextResponse.json({ keys });
      } catch (retryError) {
        console.error('[API_KEYS GET RETRY ERROR]:', retryError);
      }
    }

    const message = error?.message?.includes('DATABASE_URL')
      ? 'Database connection error: DATABASE_URL is not configured or unreachable.'
      : 'Failed to retrieve API keys from database.';

    return NextResponse.json({ error: message, code: error?.code }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const isAdmin = await authenticateAdminRequest();
  if (!isAdmin) {
    return NextResponse.json({ error: 'Unauthorized. Please sign in as an administrator.' }, { status: 401 });
  }

  const ip = req.headers.get('x-forwarded-for') || req.ip || 'unknown';

  try {
    const body = await req.json().catch(() => ({}));
    const label = body.label?.trim() || `Support Operator Key - ${new Date().toLocaleDateString()}`;

    // Ensure database tables exist
    await ensureDatabaseInitialized();

    // Cryptographically secure generation (never Math.random())
    const { rawKey, keyHash, keyPrefix } = generateSecureApiKey();

    let createdKey;
    try {
      createdKey = await prisma.apiKey.create({
        data: {
          keyHash,
          keyPrefix,
          label,
        },
      });
    } catch (insertError: any) {
      console.warn('[API_KEY INSERT WARNING]:', insertError);
      // If table doesn't exist, initialize and retry once
      if (insertError?.code === 'P2021' || insertError?.message?.includes('does not exist')) {
        await ensureDatabaseInitialized();
        createdKey = await prisma.apiKey.create({
          data: {
            keyHash,
            keyPrefix,
            label,
          },
        });
      } else {
        throw insertError;
      }
    }

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
        rawKey, // Returned ONLY once to admin upon generation!
        keyPrefix,
        label,
        createdAt: createdKey.createdAt,
      },
    });
  } catch (error: any) {
    console.error('[API_KEY CREATE FATAL ERROR]:', error);

    let errorMessage = 'Failed to create API key in database.';
    if (error?.code === 'P1001') {
      errorMessage = 'Cannot reach database server. Please check PostgreSQL DATABASE_URL status.';
    } else if (error?.code === 'P1012' || error?.message?.includes('DATABASE_URL')) {
      errorMessage = 'DATABASE_URL environment variable is missing or invalid in Vercel configuration.';
    } else if (error?.code === 'P2002') {
      errorMessage = 'An API key with this hash already exists. Please try generating again.';
    } else if (error?.message) {
      errorMessage = `Database error: ${error.message}`;
    }

    return NextResponse.json(
      {
        error: errorMessage,
        code: error?.code || 'DB_ERROR',
      },
      { status: 500 }
    );
  }
}
