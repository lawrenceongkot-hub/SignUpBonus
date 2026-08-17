import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';

const PORT = parseInt(process.env.SIGNALING_PORT || process.env.PORT || '8080', 10);

interface ClientConnection {
  ws: WebSocket;
  sessionId: string;
  role: 'operator' | 'device';
  connectedAt: Date;
}

interface SessionRoom {
  sessionId: string;
  operator?: ClientConnection;
  device?: ClientConnection;
  createdAt: Date;
}

const rooms = new Map<string, SessionRoom>();

const server = http.createServer((req, res) => {
  // Simple health check endpoint for deployment monitoring (e.g. Railway, Render, Docker)
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'healthy',
        activeRooms: rooms.size,
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket, req) => {
  let client: ClientConnection | null = null;

  ws.on('message', (messageData: string) => {
    try {
      const data = JSON.parse(messageData.toString());
      const { type, sessionId, payload, role } = data;

      if (!sessionId) {
        ws.send(JSON.stringify({ type: 'error', message: 'sessionId is required' }));
        return;
      }

      let room = rooms.get(sessionId);
      if (!room) {
        room = { sessionId, createdAt: new Date() };
        rooms.set(sessionId, room);
      }

      switch (type) {
        case 'join': {
          const clientRole = (role || 'operator') as 'operator' | 'device';
          client = { ws, sessionId, role: clientRole, connectedAt: new Date() };

          if (clientRole === 'operator') {
            room.operator = client;
            console.log(`[SIGNALING] Operator joined session: ${sessionId}`);
            // If device is already present, notify operator
            if (room.device && room.device.ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'peer-joined', role: 'device' }));
              room.device.ws.send(JSON.stringify({ type: 'peer-joined', role: 'operator' }));
            }
          } else {
            room.device = client;
            console.log(`[SIGNALING] Device joined session: ${sessionId}`);
            // If operator is present, notify operator
            if (room.operator && room.operator.ws.readyState === WebSocket.OPEN) {
              room.operator.ws.send(JSON.stringify({ type: 'peer-joined', role: 'device' }));
              ws.send(JSON.stringify({ type: 'peer-joined', role: 'operator' }));
            }
          }

          ws.send(JSON.stringify({ type: 'joined', sessionId, role: clientRole }));
          break;
        }

        case 'offer': {
          console.log(`[SIGNALING] Relaying SDP Offer for session: ${sessionId}`);
          const target = client?.role === 'operator' ? room.device : room.operator;
          if (target && target.ws.readyState === WebSocket.OPEN) {
            target.ws.send(JSON.stringify({ type: 'offer', offer: payload || data.offer, from: client?.role }));
          } else {
            console.warn(`[SIGNALING] Target not ready for offer in session: ${sessionId}`);
          }
          break;
        }

        case 'answer': {
          console.log(`[SIGNALING] Relaying SDP Answer for session: ${sessionId}`);
          const target = client?.role === 'operator' ? room.device : room.operator;
          if (target && target.ws.readyState === WebSocket.OPEN) {
            target.ws.send(JSON.stringify({ type: 'answer', answer: payload || data.answer, from: client?.role }));
          } else {
            console.warn(`[SIGNALING] Target not ready for answer in session: ${sessionId}`);
          }
          break;
        }

        case 'ice-candidate': {
          const target = client?.role === 'operator' ? room.device : room.operator;
          if (target && target.ws.readyState === WebSocket.OPEN) {
            target.ws.send(
              JSON.stringify({
                type: 'ice-candidate',
                candidate: payload || data.candidate,
                from: client?.role,
              })
            );
          }
          break;
        }

        case 'device-ready': {
          console.log(`[SIGNALING] Device reported ready for session: ${sessionId}`);
          if (room.operator && room.operator.ws.readyState === WebSocket.OPEN) {
            room.operator.ws.send(JSON.stringify({ type: 'device-ready', payload }));
          }
          break;
        }

        case 'interaction': {
          // Relays remote interaction event if DataChannel is unavailable or negotiating
          if (room.device && room.device.ws.readyState === WebSocket.OPEN) {
            room.device.ws.send(JSON.stringify({ type: 'interaction', payload: payload || data.payload }));
          }
          break;
        }

        case 'stop-session': {
          console.log(`[SIGNALING] Stop session requested for: ${sessionId}`);
          if (room.operator && room.operator.ws.readyState === WebSocket.OPEN) {
            room.operator.ws.send(JSON.stringify({ type: 'session-stopped', initiator: client?.role }));
          }
          if (room.device && room.device.ws.readyState === WebSocket.OPEN) {
            room.device.ws.send(JSON.stringify({ type: 'session-stopped', initiator: client?.role }));
          }
          rooms.delete(sessionId);
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        }

        default:
          console.warn(`[SIGNALING] Unhandled message type: ${type}`);
      }
    } catch (err) {
      console.error('[SIGNALING ERROR] Error parsing message:', err);
    }
  });

  ws.on('close', () => {
    if (client) {
      const { sessionId, role } = client;
      console.log(`[SIGNALING] ${role} disconnected from session: ${sessionId}`);
      const room = rooms.get(sessionId);
      if (room) {
        if (role === 'operator') {
          room.operator = undefined;
          if (room.device && room.device.ws.readyState === WebSocket.OPEN) {
            room.device.ws.send(JSON.stringify({ type: 'peer-disconnected', role: 'operator' }));
          }
        } else {
          room.device = undefined;
          if (room.operator && room.operator.ws.readyState === WebSocket.OPEN) {
            room.operator.ws.send(JSON.stringify({ type: 'peer-disconnected', role: 'device' }));
          }
        }

        if (!room.operator && !room.device) {
          rooms.delete(sessionId);
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[SIGNALING] WebSocket client error:', err);
  });
});

server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` Remote Support WebRTC Signaling Server`);
  console.log(` Listening on port: ${PORT}`);
  console.log(` Health check: http://localhost:${PORT}/health`);
  console.log(` WebSocket URL: ws://localhost:${PORT}`);
  console.log(`=========================================`);
});
