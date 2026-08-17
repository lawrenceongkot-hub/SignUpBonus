'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import {
  Key,
  Shield,
  QrCode,
  Copy,
  Check,
  StopCircle,
  Monitor,
  Smartphone,
  Activity,
  MousePointer,
  ChevronLeft,
  Square,
  Circle,
  Clock,
  AlertCircle,
  Lock,
  Send,
} from 'lucide-react';
import { UniversalSignalingClient } from '@/lib/signaling-client';

type OperatorStatus =
  | 'UNAUTHENTICATED'
  | 'AUTHENTICATED'
  | 'WAITING'
  | 'PAIRING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'SCREEN_SHARING_ACTIVE'
  | 'REMOTE_INTERACTION_AUTHORIZED'
  | 'DISCONNECTED'
  | 'FAILED'
  | 'SESSION_ENDED';

interface SessionData {
  id: string;
  pairingUrl: string;
  rawToken: string;
  expiresAt: string;
}

interface StreamStats {
  resolution: string;
  fps: number;
  bitrateKbps: number;
  rttMs: number;
  packetsLost: number;
}

export default function OperatorDashboard() {
  const [apiKey, setApiKey] = useState<string>('');
  const [keyLabel, setKeyLabel] = useState<string>('');
  const [keyPrefix, setKeyPrefix] = useState<string>('');
  const [authError, setAuthError] = useState<string>('');
  const [authenticating, setAuthenticating] = useState<boolean>(false);

  const [status, setStatus] = useState<OperatorStatus>('UNAUTHENTICATED');
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [creatingSession, setCreatingSession] = useState<boolean>(false);
  const [copiedUrl, setCopiedUrl] = useState<boolean>(false);
  const [timeLeft, setTimeLeft] = useState<string>('');

  // Diagnostics & Stats
  const [stats, setStats] = useState<StreamStats>({
    resolution: 'Waiting for stream...',
    fps: 0,
    bitrateKbps: 0,
    rttMs: 0,
    packetsLost: 0,
  });

  // Interaction tool state
  const [remoteText, setRemoteText] = useState<string>('');
  const [interactionEnabled, setInteractionEnabled] = useState<boolean>(true);
  const [lastAction, setLastAction] = useState<string>('Ready for interaction');

  // WebRTC references
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const signalingRef = useRef<UniversalSignalingClient | null>(null);
  const statsIntervalRef = useRef<any>(null);
  const dragStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  // 1. Authenticate Operator API Key
  const handleAuthenticate = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthenticating(true);

    try {
      const res = await fetch('/api/operator/verify-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });

      const data = await res.json();

      if (res.ok && data.valid) {
        setKeyLabel(data.label || 'Operator Key');
        setKeyPrefix(data.keyPrefix || 'rs_live_***');
        setStatus('AUTHENTICATED');
      } else {
        setAuthError(data.error || 'Authentication failed. Please check your API key.');
      }
    } catch (err) {
      setAuthError('Connection error while validating API key.');
    } finally {
      setAuthenticating(false);
    }
  };

  // 2. Create Temporary Session & QR Code
  const handleCreateSession = async () => {
    setCreatingSession(true);
    setAuthError('');

    try {
      const res = await fetch('/api/operator/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });

      const data = await res.json();

      if (res.ok && data.session) {
        setSessionData(data.session);
        setStatus('WAITING');
        // Initialize WebRTC signaling connection
        initOperatorSignaling(data.session.id, data.session.rawToken);
      } else {
        setAuthError(data.error || 'Failed to create pairing session.');
      }
    } catch (err) {
      setAuthError('Network error while creating session.');
    } finally {
      setCreatingSession(false);
    }
  };

  // Countdown timer for session expiration
  useEffect(() => {
    if (!sessionData?.expiresAt || status === 'SESSION_ENDED') return;

    const interval = setInterval(() => {
      const remaining = new Date(sessionData.expiresAt).getTime() - Date.now();
      if (remaining <= 0) {
        setTimeLeft('00:00 (Expired)');
        clearInterval(interval);
        handleStopSession();
      } else {
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        setTimeLeft(`${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [sessionData, status]);

  // 3. WebRTC Operator Signaling & Stream Setup
  const initOperatorSignaling = async (sessionId: string, rawToken: string) => {
    try {
      // Fetch ICE Server config (STUN/TURN)
      const iceRes = await fetch('/api/ice-servers');
      const rtcConfig = await iceRes.json();

      const pc = new RTCPeerConnection(rtcConfig);
      peerConnectionRef.current = pc;

      // Create DataChannel for Remote Interaction
      const dc = pc.createDataChannel('interaction', {
        ordered: true,
      });
      dataChannelRef.current = dc;

      dc.onopen = () => {
        console.log('[WEBRTC] DataChannel opened');
        setStatus((prev) => (prev === 'SCREEN_SHARING_ACTIVE' ? 'REMOTE_INTERACTION_AUTHORIZED' : prev));
      };

      // Handle incoming remote video track
      pc.ontrack = (event) => {
        console.log('[WEBRTC] Remote track received:', event.track.kind);
        if (event.streams && event.streams[0] && videoRef.current) {
          videoRef.current.srcObject = event.streams[0];
          setStatus('SCREEN_SHARING_ACTIVE');
        }
      };

      pc.onconnectionstatechange = () => {
        console.log('[WEBRTC] Connection state:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          setStatus('CONNECTED');
          startStatsMonitor(pc);
        } else if (pc.connectionState === 'disconnected') {
          setStatus('DISCONNECTED');
        } else if (pc.connectionState === 'failed') {
          setStatus('FAILED');
        } else if (pc.connectionState === 'closed') {
          setStatus('SESSION_ENDED');
        }
      };

      // Universal Signaling Client (Vercel Serverless & WebSocket support)
      const signaling = new UniversalSignalingClient(
        sessionId,
        'operator',
        rawToken,
        async (msg) => {
          try {
            if (msg.type === 'offer' && msg.offer) {
              console.log('[WEBRTC] Operator received SDP Offer');
              setStatus('CONNECTING');
              await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);

              console.log('[WEBRTC] Operator sending SDP Answer');
              signaling.send({
                type: 'answer',
                answer,
              });
            } else if (msg.type === 'ice-candidate' && msg.candidate) {
              await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } else if (msg.type === 'session-stopped') {
              handleStopSession(false);
            }
          } catch (e) {
            console.error('[WEBRTC] Error processing signaling on operator:', e);
          }
        }
      );

      signalingRef.current = signaling;

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          signaling.send({
            type: 'ice-candidate',
            candidate: event.candidate,
          });
        }
      };

      signaling.connect();

    } catch (err) {
      console.error('Signaling init error:', err);
      setStatus('FAILED');
      setLastAction('Failed to initialize signaling connection.');
    }
  };

  // Real-time WebRTC stats monitoring (getStats)
  const startStatsMonitor = (pc: RTCPeerConnection) => {
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);

    let prevBytes = 0;
    let prevTimestamp = Date.now();

    statsIntervalRef.current = setInterval(async () => {
      if (pc.connectionState !== 'connected') return;

      try {
        const statsReport = await pc.getStats();
        statsReport.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            const now = Date.now();
            const timeDiff = (now - prevTimestamp) / 1000;
            const bytes = report.bytesReceived || 0;
            const bitrate = timeDiff > 0 ? Math.round(((bytes - prevBytes) * 8) / (timeDiff * 1000)) : 0;

            prevBytes = bytes;
            prevTimestamp = now;

            setStats((s) => ({
              ...s,
              resolution: `${report.frameWidth || 1080}x${report.frameHeight || 1920}`,
              fps: Math.round(report.framesPerSecond || 30),
              bitrateKbps: bitrate,
              packetsLost: report.packetsLost || 0,
            }));
          } else if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            setStats((s) => ({
              ...s,
              rttMs: Math.round((report.currentRoundTripTime || 0) * 1000),
            }));
          }
        });
      } catch (e) {
        // Ignore stats errors during teardown
      }
    }, 1000);
  };

  // 4. Send Remote Interaction Commands over DataChannel
  const sendRemoteCommand = (command: Record<string, any>) => {
    if (!interactionEnabled) return;

    // Send via DataChannel if open
    if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
      dataChannelRef.current.send(JSON.stringify(command));
      setLastAction(`Sent: ${command.type}`);
    } else if (signalingRef.current) {
      // Fallback via Universal Signaling
      signalingRef.current.send({
        type: 'interaction',
        payload: command,
      });
      setLastAction(`Sent: ${command.type} (via Signaling Relay)`);
    }
  };

  // Translate click / touch on video to relative (0.0 to 1.0) coordinates
  const handleVideoMouseDown = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!videoRef.current) return;
    const rect = videoRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    dragStartRef.current = { x, y, time: Date.now() };
  };

  const handleVideoMouseUp = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!videoRef.current || !dragStartRef.current) return;
    const rect = videoRef.current.getBoundingClientRect();
    const endX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const endY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const duration = Date.now() - dragStartRef.current.time;
    const distance = Math.hypot(endX - dragStartRef.current.x, endY - dragStartRef.current.y);

    if (distance < 0.03) {
      // Considered a Tap / Click
      sendRemoteCommand({ type: 'tap', x: endX, y: endY });
    } else {
      // Considered a Swipe / Drag Gesture
      sendRemoteCommand({
        type: 'swipe',
        startX: dragStartRef.current.x,
        startY: dragStartRef.current.y,
        endX,
        endY,
        duration: Math.min(duration, 1000),
      });
    }

    dragStartRef.current = null;
  };

  const handleVideoWheel = (e: React.WheelEvent<HTMLVideoElement>) => {
    sendRemoteCommand({
      type: 'scroll',
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  };

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!remoteText.trim()) return;
    sendRemoteCommand({ type: 'text', text: remoteText });
    setRemoteText('');
  };

  // 5. Stop Session Workflow
  const handleStopSession = async (notifyServer = true) => {
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);

    if (notifyServer && sessionData?.id) {
      try {
        await fetch(`/api/operator/sessions/${sessionData.id}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey }),
        });
      } catch (e) {
        console.error('Stop session server error:', e);
      }
    }

    if (signalingRef.current) {
      signalingRef.current.send({ type: 'stop-session' });
      signalingRef.current.close();
      signalingRef.current = null;
    }

    if (dataChannelRef.current) dataChannelRef.current.close();
    if (peerConnectionRef.current) peerConnectionRef.current.close();
    if (videoRef.current) videoRef.current.srcObject = null;

    setStatus('SESSION_ENDED');
  };

  const copyPairingUrl = () => {
    if (sessionData?.pairingUrl) {
      navigator.clipboard.writeText(sessionData.pairingUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 3000);
    }
  };

  // Helper for status badge rendering
  const getStatusBadge = () => {
    switch (status) {
      case 'WAITING':
        return <span className="badge badge-waiting">Waiting for User Scan</span>;
      case 'PAIRING':
        return <span className="badge badge-pairing">Pairing in Progress</span>;
      case 'CONNECTING':
        return <span className="badge badge-connecting">Connecting WebRTC</span>;
      case 'CONNECTED':
        return <span className="badge badge-connected">Peer Connected</span>;
      case 'SCREEN_SHARING_ACTIVE':
        return <span className="badge badge-active">● Screen Sharing Active</span>;
      case 'REMOTE_INTERACTION_AUTHORIZED':
        return <span className="badge badge-interaction">⚡ Remote Interaction Authorized</span>;
      case 'DISCONNECTED':
        return <span className="badge badge-disconnected">Disconnected</span>;
      case 'FAILED':
        return <span className="badge badge-failed">Connection Failed</span>;
      case 'SESSION_ENDED':
        return <span className="badge badge-ended">Session Ended</span>;
      default:
        return null;
    }
  };

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '24px 20px', width: '100%' }}>
      {/* Top Navbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px', flexWrap: 'wrap', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{
            width: '46px',
            height: '46px',
            borderRadius: '12px',
            background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            boxShadow: '0 4px 14px rgba(37, 99, 235, 0.4)'
          }}>
            <Monitor size={24} />
          </div>
          <div>
            <h1 style={{ fontSize: '24px', fontWeight: '800', letterSpacing: '-0.5px' }}>REMOTE SUPPORT</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
              Enterprise Live Screen Assistance & Remote Interaction Platform
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Link href="/generateapi" className="btn-secondary" style={{ fontSize: '13px' }}>
            <Key size={16} /> Admin API Keys
          </Link>
        </div>
      </div>

      {/* STEP 1: Operator Authentication */}
      {status === 'UNAUTHENTICATED' && (
        <div style={{ maxWidth: '520px', margin: '40px auto' }}>
          <div className="glass-panel" style={{ padding: '36px 30px' }}>
            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <div style={{
                width: '54px',
                height: '54px',
                borderRadius: '14px',
                background: 'rgba(59, 130, 246, 0.15)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-blue)',
                marginBottom: '14px'
              }}>
                <Shield size={28} />
              </div>
              <h2 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '6px' }}>Operator Authentication</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
                Enter your authorized API key to initialize support sessions.
              </p>
            </div>

            {authError && (
              <div style={{
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#fca5a5',
                padding: '12px',
                borderRadius: '8px',
                marginBottom: '20px',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                <AlertCircle size={16} />
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={handleAuthenticate} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  API Key
                </label>
                <input
                  type="password"
                  className="glass-input"
                  placeholder="rs_live_••••••••••••••••••••••••"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  required
                  autoComplete="off"
                />
              </div>

              <button
                type="submit"
                className="btn-primary"
                disabled={authenticating || !apiKey.trim()}
                style={{ height: '44px', width: '100%' }}
              >
                <Lock size={16} />
                {authenticating ? 'Validating API Key...' : 'Authenticate'}
              </button>
            </form>

            <div style={{ marginTop: '20px', textAlign: 'center', fontSize: '13px', color: 'var(--text-muted)' }}>
              Need an API key? Ask an administrator or visit the{' '}
              <Link href="/generateapi" style={{ color: 'var(--accent-blue)', fontWeight: '600' }}>
                Admin Panel
              </Link>
              .
            </div>
          </div>
        </div>
      )}

      {/* STEP 2: Authenticated — Create Session & Pairing QR */}
      {status !== 'UNAUTHENTICATED' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 380px) 1fr', gap: '24px', alignItems: 'start' }}>
          {/* Left Column: Operator Info, Session Info & QR Code */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Operator Card */}
            <div className="glass-panel" style={{ padding: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--accent-green)' }} />
                  <span style={{ fontSize: '14px', fontWeight: '600' }}>{keyLabel}</span>
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-muted)' }}>
                  {keyPrefix}
                </span>
              </div>

              {!sessionData && status === 'AUTHENTICATED' && (
                <button
                  onClick={handleCreateSession}
                  className="btn-primary"
                  disabled={creatingSession}
                  style={{ width: '100%', height: '44px' }}
                >
                  <QrCode size={18} />
                  {creatingSession ? 'Generating Session...' : 'Create QR Code'}
                </button>
              )}

              {sessionData && (
                <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Session ID:</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: '#93c5fd' }}>
                      {sessionData.id.substring(0, 8)}...
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Expires In:</span>
                    <span style={{ color: 'var(--accent-yellow)', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Clock size={13} /> {timeLeft || '15:00'}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* QR Code Card */}
            {sessionData && status !== 'SESSION_ENDED' && (
              <div className="glass-panel" style={{ padding: '24px', textAlign: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                  <span style={{ fontSize: '14px', fontWeight: '700' }}>Pairing QR Code</span>
                  {getStatusBadge()}
                </div>

                <div style={{
                  background: 'white',
                  padding: '16px',
                  borderRadius: '12px',
                  display: 'inline-block',
                  margin: '0 auto 16px',
                  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)'
                }}>
                  <QRCodeSVG
                    value={sessionData.pairingUrl}
                    size={220}
                    level="H"
                    includeMargin={false}
                  />
                </div>

                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: '1.4' }}>
                  Scan with target Android device or open the temporary pairing URL in Chrome.
                </p>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    readOnly
                    value={sessionData.pairingUrl}
                    className="glass-input"
                    style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: '#94a3b8' }}
                  />
                  <button onClick={copyPairingUrl} className="btn-secondary" style={{ padding: '8px 12px' }} title="Copy Pairing Link">
                    {copiedUrl ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
              </div>
            )}

            {/* Diagnostics Card */}
            <div className="glass-panel" style={{ padding: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                <Activity size={18} style={{ color: 'var(--accent-blue)' }} />
                <span style={{ fontSize: '14px', fontWeight: '700' }}>Stream Diagnostics</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '13px' }}>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px' }}>
                  <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '11px' }}>Resolution</span>
                  <span style={{ fontWeight: '600', color: '#e2e8f0' }}>{stats.resolution}</span>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px' }}>
                  <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '11px' }}>Frame Rate</span>
                  <span style={{ fontWeight: '600', color: '#e2e8f0' }}>{stats.fps} FPS</span>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px' }}>
                  <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '11px' }}>Bitrate</span>
                  <span style={{ fontWeight: '600', color: '#e2e8f0' }}>{stats.bitrateKbps} kbps</span>
                </div>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px' }}>
                  <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '11px' }}>Latency (RTT)</span>
                  <span style={{ fontWeight: '600', color: '#e2e8f0' }}>{stats.rttMs} ms</span>
                </div>
              </div>

              <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
                <span>Status: {lastAction}</span>
              </div>
            </div>

            {/* Stop Session Action */}
            {sessionData && status !== 'SESSION_ENDED' && (
              <button
                onClick={() => handleStopSession(true)}
                className="btn-danger"
                style={{ width: '100%', height: '46px', fontSize: '15px' }}
              >
                <StopCircle size={20} /> STOP SESSION
              </button>
            )}

            {status === 'SESSION_ENDED' && (
              <div className="glass-panel" style={{ padding: '20px', textAlign: 'center', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                <h3 style={{ fontSize: '16px', fontWeight: '700', color: '#f87171', marginBottom: '8px' }}>SESSION ENDED</h3>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
                  The remote support session was safely terminated and security tokens revoked.
                </p>
                <button onClick={handleCreateSession} className="btn-primary" style={{ width: '100%' }}>
                  Start New Session
                </button>
              </div>
            )}
          </div>

          {/* Right Column: Live Video Viewer & Remote Interaction Controls */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="glass-panel" style={{ padding: '20px', minHeight: '600px', display: 'flex', flexDirection: 'column' }}>
              {/* Screen Viewer Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Smartphone size={20} style={{ color: 'var(--accent-blue)' }} />
                  <span style={{ fontSize: '16px', fontWeight: '700' }}>Live Device Screen</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {getStatusBadge()}
                </div>
              </div>

              {/* Live Video Canvas Container */}
              <div
                style={{
                  flex: 1,
                  background: '#000',
                  borderRadius: '10px',
                  overflow: 'hidden',
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minHeight: '480px',
                  border: '1px solid var(--border-color)',
                  userSelect: 'none',
                }}
              >
                {/* Real Live Video */}
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  onMouseDown={handleVideoMouseDown}
                  onMouseUp={handleVideoMouseUp}
                  onWheel={handleVideoWheel}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                    cursor: interactionEnabled ? 'crosshair' : 'default',
                    display: (status === 'SCREEN_SHARING_ACTIVE' || status === 'REMOTE_INTERACTION_AUTHORIZED') ? 'block' : 'none',
                  }}
                />

                {/* Placeholder / Waiting State */}
                {(status === 'WAITING' || status === 'PAIRING' || status === 'CONNECTING' || status === 'AUTHENTICATED') && (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)' }}>
                    <Smartphone size={56} style={{ margin: '0 auto 16px', opacity: 0.3 }} />
                    <h3 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '8px', color: 'var(--text-primary)' }}>
                      Waiting for Device Stream
                    </h3>
                    <p style={{ fontSize: '13px', maxWidth: '360px', margin: '0 auto', color: 'var(--text-muted)' }}>
                      Scan the QR code on the target Android phone or open the pairing URL to begin real-time screen sharing.
                    </p>
                  </div>
                )}

                {status === 'SESSION_ENDED' && (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)' }}>
                    <StopCircle size={56} style={{ margin: '0 auto 16px', color: '#f87171', opacity: 0.8 }} />
                    <h3 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '8px', color: 'var(--text-primary)' }}>
                      Session Terminated
                    </h3>
                    <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      Video stream closed. No device data is transmitting.
                    </p>
                  </div>
                )}
              </div>

              {/* Authorized Remote Interaction Toolbar */}
              {(status === 'SCREEN_SHARING_ACTIVE' || status === 'REMOTE_INTERACTION_AUTHORIZED') && (
                <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {/* Remote Text Injection Bar */}
                  <form onSubmit={handleSendText} style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="text"
                      className="glass-input"
                      placeholder="Type text to inject into active remote input field..."
                      value={remoteText}
                      onChange={(e) => setRemoteText(e.target.value)}
                    />
                    <button type="submit" className="btn-primary" style={{ minWidth: '110px' }}>
                      <Send size={15} /> Inject
                    </button>
                  </form>

                  {/* Android System Navigation Buttons */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(0,0,0,0.3)', padding: '10px 16px', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <MousePointer size={16} style={{ color: 'var(--accent-purple)' }} />
                      <span style={{ fontSize: '13px', fontWeight: '600' }}>Android Navigation:</span>
                    </div>

                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={() => sendRemoteCommand({ type: 'key', key: 'BACK' })}
                        className="btn-secondary"
                        style={{ padding: '6px 14px', fontSize: '12px' }}
                        title="Back"
                      >
                        <ChevronLeft size={16} /> Back
                      </button>
                      <button
                        onClick={() => sendRemoteCommand({ type: 'key', key: 'HOME' })}
                        className="btn-secondary"
                        style={{ padding: '6px 14px', fontSize: '12px' }}
                        title="Home"
                      >
                        <Circle size={14} /> Home
                      </button>
                      <button
                        onClick={() => sendRemoteCommand({ type: 'key', key: 'RECENTS' })}
                        className="btn-secondary"
                        style={{ padding: '6px 14px', fontSize: '12px' }}
                        title="Recent Apps"
                      >
                        <Square size={14} /> Recents
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
