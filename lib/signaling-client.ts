/**
 * Universal WebRTC Signaling Client
 * Automatically uses WebSocket if an external WSS server is provided,
 * otherwise falls back seamlessly to HTTP Serverless Signaling.
 */

export interface SignalingMessage {
  type: string;
  role?: 'operator' | 'device';
  from?: 'operator' | 'device';
  offer?: any;
  answer?: any;
  candidate?: any;
  payload?: any;
}

export type MessageHandler = (msg: SignalingMessage) => void;

export class UniversalSignalingClient {
  private sessionId: string;
  private role: 'operator' | 'device';
  private token: string;
  private ws: WebSocket | null = null;
  private isUsingPolling = false;
  private pollInterval: any = null;
  private lastMessageId = 0;
  private onMessageCallback: MessageHandler;
  private isClosed = false;

  constructor(
    sessionId: string,
    role: 'operator' | 'device',
    token: string,
    onMessage: MessageHandler
  ) {
    this.sessionId = sessionId;
    this.role = role;
    this.token = token;
    this.onMessageCallback = onMessage;
  }

  public connect() {
    let wsUrl = process.env.NEXT_PUBLIC_WS_URL;

    // Check if a real dedicated external WebSocket URL is configured
    const isCustomWs =
      wsUrl &&
      wsUrl !== 'wss://signaling.example.com' &&
      !wsUrl.includes('vercel.app') &&
      !wsUrl.includes('localhost');

    if (isCustomWs) {
      try {
        console.log('[SIGNALING] Attempting dedicated WebSocket connection to:', wsUrl);
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          console.log('[SIGNALING] WebSocket connected');
          this.ws?.send(
            JSON.stringify({
              type: 'join',
              sessionId: this.sessionId,
              role: this.role,
              token: this.token,
            })
          );
        };

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            this.onMessageCallback(data);
          } catch (e) {
            console.error('Error parsing WS message:', e);
          }
        };

        this.ws.onerror = () => {
          console.warn('[SIGNALING] WebSocket failed. Switching to Serverless HTTP Signaling.');
          this.startHttpSignaling();
        };

        this.ws.onclose = () => {
          if (!this.isClosed && !this.isUsingPolling) {
            this.startHttpSignaling();
          }
        };

        return;
      } catch (err) {
        console.warn('[SIGNALING] WS init error. Falling back to HTTP signaling:', err);
      }
    }

    // Default: Fast Serverless HTTP Signaling (compatible with Vercel)
    this.startHttpSignaling();
  }

  private startHttpSignaling() {
    if (this.isUsingPolling || this.isClosed) return;
    this.isUsingPolling = true;
    console.log('[SIGNALING] Using Serverless HTTP Signaling Relay for session:', this.sessionId);

    // Initial Join Ping
    this.sendHttpSignal({ type: 'join', role: this.role });

    // Poll every 600ms for incoming signaling messages (SDP offer/answer, ICE candidates)
    this.pollInterval = setInterval(async () => {
      if (this.isClosed) return;
      try {
        const res = await fetch(
          `/api/signaling/${this.sessionId}?role=${this.role}&lastId=${this.lastMessageId}`,
          { cache: 'no-store' }
        );

        if (res.ok) {
          const data = await res.json();
          if (data.messages && Array.isArray(data.messages)) {
            for (const msg of data.messages) {
              if (msg.id > this.lastMessageId) {
                this.lastMessageId = msg.id;
                this.onMessageCallback({
                  type: msg.type,
                  from: msg.from,
                  offer: msg.payload?.offer || (msg.type === 'offer' ? msg.payload : undefined),
                  answer: msg.payload?.answer || (msg.type === 'answer' ? msg.payload : undefined),
                  candidate: msg.payload?.candidate || (msg.type === 'ice-candidate' ? msg.payload : undefined),
                  payload: msg.payload,
                });
              }
            }
          }
        }
      } catch (pollErr) {
        // Suppress temporary network jitter during polling
      }
    }, 600);
  }

  public send(data: Record<string, any>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.isUsingPolling) {
      this.ws.send(
        JSON.stringify({
          sessionId: this.sessionId,
          role: this.role,
          ...data,
        })
      );
    } else {
      this.sendHttpSignal(data);
    }
  }

  private async sendHttpSignal(data: Record<string, any>) {
    try {
      await fetch(`/api/signaling/${this.sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.sessionId,
          role: this.role,
          ...data,
        }),
      });
    } catch (e) {
      console.error('[SIGNALING SEND ERROR]:', e);
    }
  }

  public close() {
    this.isClosed = true;
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
