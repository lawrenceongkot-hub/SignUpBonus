import { NextRequest, NextResponse } from 'next/server';
import { prisma, isDatabaseConfigured, ensureDatabaseInitialized } from '@/lib/prisma';

interface InMemoryMessage {
  id: number;
  sessionId: string;
  fromRole: string;
  type: string;
  payload: any;
  createdAt: number;
}

// Fallback in-memory cache for local development
const memoryCache: InMemoryMessage[] = [];
let memoryIdCounter = 1;

export async function GET(req: NextRequest, { params }: { params: { sessionId: string } }) {
  const { sessionId } = params;
  const role = req.nextUrl.searchParams.get('role') as 'operator' | 'device' | null;
  const lastId = parseInt(req.nextUrl.searchParams.get('lastId') || '0', 10);

  if (!sessionId || !role) {
    return NextResponse.json({ error: 'sessionId and role are required' }, { status: 400 });
  }

  try {
    if (isDatabaseConfigured()) {
      await ensureDatabaseInitialized();

      // Retrieve messages from PostgreSQL database across any serverless isolate
      const messages = await (prisma as any).signalingMessage.findMany({
        where: {
          sessionId,
          fromRole: { not: role },
          id: { gt: lastId },
        },
        orderBy: { id: 'asc' },
        take: 50,
      });

      const parsedMessages = messages.map((m: any) => ({
        id: m.id,
        type: m.type,
        from: m.fromRole,
        payload: JSON.parse(m.payload),
        createdAt: m.createdAt,
      }));

      const latestMsg = await (prisma as any).signalingMessage.findFirst({
        where: { sessionId },
        orderBy: { id: 'desc' },
      });

      return NextResponse.json({
        messages: parsedMessages,
        lastId: latestMsg ? latestMsg.id : lastId,
      });
    }
  } catch (dbError) {
    console.warn('[SIGNALING DB GET WARNING]:', dbError);
  }

  // In-memory fallback
  const newMessages = memoryCache.filter(
    (m) => m.sessionId === sessionId && m.fromRole !== role && m.id > lastId
  );

  return NextResponse.json({
    messages: newMessages,
    lastId: memoryCache.length > 0 ? memoryCache[memoryCache.length - 1].id : lastId,
  });
}

export async function POST(req: NextRequest, { params }: { params: { sessionId: string } }) {
  const { sessionId } = params;

  try {
    const body = await req.json();
    const { type, role, payload, offer, answer, candidate } = body;

    if (!sessionId || !type || !role) {
      return NextResponse.json({ error: 'sessionId, type, and role are required' }, { status: 400 });
    }

    const messageData = payload || offer || answer || candidate || body;
    const payloadStr = JSON.stringify(messageData);

    let messageId = 0;

    if (isDatabaseConfigured()) {
      try {
        await ensureDatabaseInitialized();

        const created = await (prisma as any).signalingMessage.create({
          data: {
            sessionId,
            fromRole: role,
            type,
            payload: payloadStr,
          },
        });

        messageId = created.id;
      } catch (dbWriteError) {
        console.warn('[SIGNALING DB WRITE WARNING]:', dbWriteError);
      }
    }

    if (!messageId) {
      messageId = memoryIdCounter++;
      memoryCache.push({
        id: messageId,
        sessionId,
        fromRole: role,
        type,
        payload: messageData,
        createdAt: Date.now(),
      });

      if (memoryCache.length > 200) {
        memoryCache.splice(0, memoryCache.length - 200);
      }
    }

    return NextResponse.json({
      success: true,
      messageId,
    });
  } catch (error: any) {
    console.error('[SIGNALING ROUTE ERROR]:', error);
    return NextResponse.json({ error: 'Failed to process signaling message' }, { status: 500 });
  }
}
