import { NextRequest, NextResponse } from 'next/server';

interface SignalingMessage {
  id: number;
  type: string;
  from: 'operator' | 'device';
  target: 'operator' | 'device' | 'all';
  payload: any;
  timestamp: number;
}

interface SessionQueue {
  messages: SignalingMessage[];
  operatorConnectedAt?: number;
  deviceConnectedAt?: number;
  lastActivity: number;
}

// In-memory signaling bus scoped by sessionId for serverless WebRTC signaling
const sessionQueues = new Map<string, SessionQueue>();

// Clean up stale sessions older than 30 minutes
function cleanupOldSessions() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, queue] of sessionQueues.entries()) {
    if (queue.lastActivity < cutoff) {
      sessionQueues.delete(id);
    }
  }
}

export async function GET(req: NextRequest, { params }: { params: { sessionId: string } }) {
  const { sessionId } = params;
  const role = req.nextUrl.searchParams.get('role') as 'operator' | 'device' | null;
  const lastId = parseInt(req.nextUrl.searchParams.get('lastId') || '0', 10);

  if (!sessionId || !role) {
    return NextResponse.json({ error: 'sessionId and role are required' }, { status: 400 });
  }

  cleanupOldSessions();

  let queue = sessionQueues.get(sessionId);
  if (!queue) {
    queue = {
      messages: [],
      lastActivity: Date.now(),
    };
    sessionQueues.set(sessionId, queue);
  }

  // Update presence timestamp
  if (role === 'operator') queue.operatorConnectedAt = Date.now();
  if (role === 'device') queue.deviceConnectedAt = Date.now();
  queue.lastActivity = Date.now();

  // Return all messages targeted to this role with id > lastId
  const newMessages = queue.messages.filter(
    (msg) => msg.id > lastId && (msg.target === role || msg.target === 'all') && msg.from !== role
  );

  return NextResponse.json({
    messages: newMessages,
    operatorActive: !!queue.operatorConnectedAt && Date.now() - queue.operatorConnectedAt < 10000,
    deviceActive: !!queue.deviceConnectedAt && Date.now() - queue.deviceConnectedAt < 10000,
    lastId: queue.messages.length > 0 ? queue.messages[queue.messages.length - 1].id : 0,
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

    cleanupOldSessions();

    let queue = sessionQueues.get(sessionId);
    if (!queue) {
      queue = {
        messages: [],
        lastActivity: Date.now(),
      };
      sessionQueues.set(sessionId, queue);
    }

    queue.lastActivity = Date.now();
    const fromRole = role as 'operator' | 'device';
    const targetRole: 'operator' | 'device' | 'all' = fromRole === 'operator' ? 'device' : 'operator';

    const messageData = payload || offer || answer || candidate || body;

    const newMsg: SignalingMessage = {
      id: queue.messages.length + 1,
      type,
      from: fromRole,
      target: type === 'stop-session' ? 'all' : targetRole,
      payload: messageData,
      timestamp: Date.now(),
    };

    queue.messages.push(newMsg);

    // Limit memory: keep last 100 messages per session
    if (queue.messages.length > 100) {
      queue.messages = queue.messages.slice(-100);
    }

    return NextResponse.json({
      success: true,
      messageId: newMsg.id,
    });
  } catch (error: any) {
    console.error('[SIGNALING ROUTE ERROR]:', error);
    return NextResponse.json({ error: 'Failed to process signaling message' }, { status: 500 });
  }
}
