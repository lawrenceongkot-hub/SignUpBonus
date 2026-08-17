'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useParams } from 'next/navigation';
import {
  Shield,
  ShieldAlert,
  Monitor,
  CheckCircle,
  XCircle,
  StopCircle,
  RefreshCw,
  Smartphone,
  Radio,
  Camera,
  ExternalLink,
  Copy,
  Check,
} from 'lucide-react';

type PairingState =
  | 'VALIDATING'
  | 'CONSENT'
  | 'CONNECTING'
  | 'STREAMING'
  | 'REJECTED'
  | 'ENDED'
  | 'ERROR';

interface Ripple {
  id: number;
  x: number;
  y: number;
}

export default function MobilePairingPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const sessionId = params?.sessionId as string;
  const token = searchParams.get('token') || '';

  const [state, setState] = useState<PairingState>('VALIDATING');
  const [operatorName, setOperatorName] = useState<string>('Support Operator');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isScreenCaptureRestricted, setIsScreenCaptureRestricted] = useState<boolean>(false);
  const [streamType, setStreamType] = useState<'screen' | 'camera'>('screen');
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [streamInfo, setStreamInfo] = useState<{ resolution: string; fps: number }>({ resolution: '', fps: 0 });
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  // 1. Validate session & token upon loading
  useEffect(() => {
    if (!sessionId || !token) {
      setErrorMessage('Missing session ID or authorization pairing token.');
      setState('ERROR');
      return;
    }

    const verifySession = async () => {
      try {
        const res = await fetch(`/api/pair/${sessionId}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        const data = await res.json();

        if (res.ok && data.valid) {
          setOperatorName(data.operatorName || 'Support Operator');
          setState('CONSENT');
        } else {
          setErrorMessage(data.error || 'Invalid or expired remote support session.');
          setState('ERROR');
        }
      } catch (err) {
        setErrorMessage('Failed to connect to verification server.');
        setState('ERROR');
      }
    };

    verifySession();
  }, [sessionId, token]);

  // Teardown WebRTC & Stream
  const stopSupportSession = async (notifyServer = true) => {
    try {
      if (notifyServer && sessionId && token) {
        fetch(`/api/pair/${sessionId}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        }).catch(() => {});
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'stop-session', sessionId, role: 'device' }));
        wsRef.current.close();
      }

      if (dataChannelRef.current) {
        dataChannelRef.current.close();
      }

      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    } catch (e) {
      console.error('Error stopping session:', e);
    } finally {
      setState('ENDED');
    }
  };

  // 2. Start WebRTC Stream (Screen or Camera) after user consents
  const startStreaming = async (mode: 'screen' | 'camera') => {
    setState('CONNECTING');
    setIsScreenCaptureRestricted(false);
    setStreamType(mode);

    try {
      let stream: MediaStream;

      if (mode === 'screen') {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
          throw new Error('BROWSER_SCREEN_RESTRICTED');
        }

        try {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              displaySurface: 'monitor',
              frameRate: { ideal: 30, max: 60 },
            },
            audio: false,
          });
        } catch (err: any) {
          console.warn('Browser getDisplayMedia error on this device:', err);
          throw new Error('BROWSER_SCREEN_RESTRICTED');
        }
      } else {
        // Camera fallback for devices where browser restricts OS-level getDisplayMedia
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: 'environment',
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
        } catch (camErr: any) {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }
      }

      localStreamRef.current = stream;

      // Handle user stopping screen share from browser banner
      stream.getVideoTracks()[0].onended = () => {
        stopSupportSession(true);
      };

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      setStreamInfo({
        resolution: `${settings.width || window.innerWidth}x${settings.height || window.innerHeight}`,
        fps: Math.round(settings.frameRate || 30),
      });

      // Inform backend & retrieve RTC ICE config
      const startRes = await fetch(`/api/pair/${sessionId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          screenResolution: `${window.screen.width}x${window.screen.height}`,
        }),
      });

      const startData = await startRes.json();
      if (!startRes.ok) {
        throw new Error(startData.error || 'Failed to initialize session on server');
      }

      const rtcConfig = startData.rtcConfig || {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      };

      // Connect to WebSocket Signaling Server
      let wsUrl = process.env.NEXT_PUBLIC_WS_URL;
      if (!wsUrl || wsUrl === 'wss://signaling.example.com') {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.hostname;
        const port = window.location.port === '3000' ? '8080' : window.location.port;
        wsUrl = `${protocol}//${host}:${port}`;
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      const pc = new RTCPeerConnection(rtcConfig);
      peerConnectionRef.current = pc;

      // Add local tracks to peer connection
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      // Setup DataChannel for receiving interaction commands
      pc.ondatachannel = (event) => {
        const dc = event.channel;
        dataChannelRef.current = dc;

        dc.onmessage = (msgEvent) => {
          try {
            const command = JSON.parse(msgEvent.data);
            handleRemoteCommand(command);
          } catch (e) {
            console.error('Error handling remote command:', e);
          }
        };
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'ice-candidate',
              sessionId,
              role: 'device',
              candidate: event.candidate,
            })
          );
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setState('STREAMING');
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          setState('ENDED');
        }
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', sessionId, role: 'device', token }));
      };

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'peer-joined' && data.role === 'operator') {
            // Initiate WebRTC Offer from device
            const offer = await pc.createOffer({
              offerToReceiveVideo: false,
              offerToReceiveAudio: false,
            });
            await pc.setLocalDescription(offer);

            ws.send(
              JSON.stringify({
                type: 'offer',
                sessionId,
                role: 'device',
                offer,
              })
            );
          } else if (data.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          } else if (data.type === 'ice-candidate' && data.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } else if (data.type === 'interaction') {
            handleRemoteCommand(data.payload);
          } else if (data.type === 'session-stopped') {
            stopSupportSession(false);
          }
        } catch (err) {
          console.error('Error handling signaling message:', err);
        }
      };

      ws.onerror = (e) => {
        console.error('[SIGNALING] Mobile WebSocket signaling error:', e);
      };

      ws.onclose = (e) => {
        console.log('[SIGNALING] Mobile signaling connection closed:', e.code);
      };
    } catch (err: any) {
      console.error('Streaming setup error:', err);
      if (err.message === 'BROWSER_SCREEN_RESTRICTED') {
        setIsScreenCaptureRestricted(true);
        setState('CONSENT');
      } else {
        setErrorMessage(err.message || 'Failed to establish remote support connection.');
        setState('ERROR');
      }
    }
  };

  const handleRemoteCommand = (cmd: any) => {
    if (!cmd) return;

    if (cmd.type === 'tap' || cmd.type === 'click') {
      const x = cmd.x * window.innerWidth;
      const y = cmd.y * window.innerHeight;

      // Add visual ripple indicator on mobile screen
      const newRipple: Ripple = { id: Date.now() + Math.random(), x, y };
      setRipples((prev) => [...prev.slice(-5), newRipple]);
      setTimeout(() => {
        setRipples((prev) => prev.filter((r) => r.id !== newRipple.id));
      }, 600);

      // Attempt to interact with DOM element at coordinates
      const elem = document.elementFromPoint(x, y) as HTMLElement;
      if (elem && typeof elem.click === 'function') {
        elem.focus();
        elem.click();
      }
    } else if (cmd.type === 'scroll') {
      window.scrollBy({ top: cmd.deltaY || 0, left: cmd.deltaX || 0, behavior: 'smooth' });
    }
  };

  const copyAppDeepLink = () => {
    const fullUrl = window.location.href;
    navigator.clipboard.writeText(fullUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 3000);
  };

  const appDeepLink = `remotesupport://pair?session=${sessionId}&token=${token}`;

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px 16px',
      position: 'relative',
      overflow: 'hidden'
    }}>
      {/* Remote Interaction Visual Indicators */}
      {ripples.map((r) => (
        <div
          key={r.id}
          className="touch-ripple"
          style={{ left: `${r.x}px`, top: `${r.y}px` }}
        />
      ))}

      {state === 'VALIDATING' && (
        <div className="glass-panel" style={{ padding: '32px', textAlign: 'center', maxWidth: '400px' }}>
          <RefreshCw className="pulse" size={32} style={{ color: 'var(--accent-blue)', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '18px', fontWeight: '700', marginBottom: '8px' }}>Validating Session</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            Checking security tokens with remote support server...
          </p>
        </div>
      )}

      {state === 'CONSENT' && (
        <div className="glass-panel" style={{ width: '100%', maxWidth: '460px', padding: '28px 22px' }}>
          <div style={{ textAlign: 'center', marginBottom: '20px' }}>
            <div style={{
              width: '56px',
              height: '56px',
              borderRadius: '16px',
              background: 'rgba(59, 130, 246, 0.15)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '12px',
              color: 'var(--accent-blue)',
              border: '1px solid rgba(59, 130, 246, 0.3)'
            }}>
              <Smartphone size={28} />
            </div>
            <h1 style={{ fontSize: '20px', fontWeight: '800', marginBottom: '6px' }}>REMOTE SUPPORT REQUEST</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
              An enterprise technician is requesting remote assistance access.
            </p>
          </div>

          {/* Session Details */}
          <div style={{
            background: 'rgba(0, 0, 0, 0.3)',
            borderRadius: '10px',
            padding: '14px 16px',
            marginBottom: '18px',
            fontSize: '13px',
            border: '1px solid var(--border-color)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Operator:</span>
              <span style={{ fontWeight: '600', color: '#93c5fd' }}>{operatorName}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Session ID:</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-muted)' }}>
                {sessionId.substring(0, 8)}...{sessionId.substring(sessionId.length - 4)}
              </span>
            </div>
          </div>

          {/* Android OS Sandbox Notice if getDisplayMedia is restricted */}
          {isScreenCaptureRestricted && (
            <div style={{
              background: 'rgba(245, 158, 11, 0.12)',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              borderRadius: '10px',
              padding: '14px',
              marginBottom: '18px',
              fontSize: '13px',
              lineHeight: '1.45',
              color: '#fef3c7'
            }}>
              <strong style={{ color: '#fbbf24', display: 'block', marginBottom: '4px' }}>
                Android OS Browser Notice:
              </strong>
              Android browser security sandboxes restrict full-system screen capture to native apps with <code>MediaProjection</code>.
              Choose an option below:
            </div>
          )}

          {!isScreenCaptureRestricted && (
            <div style={{
              background: 'rgba(59, 130, 246, 0.1)',
              border: '1px solid rgba(59, 130, 246, 0.25)',
              borderRadius: '10px',
              padding: '14px',
              marginBottom: '20px',
              fontSize: '13px',
              lineHeight: '1.45',
              color: '#e2e8f0'
            }}>
              <strong style={{ color: '#93c5fd', display: 'block', marginBottom: '4px' }}>Explicit Consent Required:</strong>
              &ldquo;The support operator is requesting permission to view and interact with your device.&rdquo;
            </div>
          )}

          {/* Support Actions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {/* Native Android App Launcher */}
            <a
              href={appDeepLink}
              className="btn-primary"
              style={{ width: '100%', height: '46px', fontSize: '14px', textDecoration: 'none' }}
            >
              <ExternalLink size={18} /> Launch Remote Support Android App
            </a>

            {/* Direct Browser Screen Share */}
            <button
              onClick={() => startStreaming('screen')}
              className="btn-success"
              style={{ width: '100%', height: '46px', fontSize: '14px' }}
            >
              <Monitor size={18} /> {isScreenCaptureRestricted ? 'Retry Browser Screen Share' : 'Allow Remote Support (Browser)'}
            </button>

            {/* Camera Visual Stream Fallback */}
            <button
              onClick={() => startStreaming('camera')}
              className="btn-secondary"
              style={{ width: '100%', height: '42px', fontSize: '13px' }}
            >
              <Camera size={16} /> Share Camera / Video Feed
            </button>

            {/* Copy Pairing Link for App */}
            <button
              onClick={copyAppDeepLink}
              className="btn-secondary"
              style={{ width: '100%', height: '38px', fontSize: '12px' }}
            >
              {copiedLink ? <Check size={14} /> : <Copy size={14} />}
              {copiedLink ? 'Copied Session URL!' : 'Copy Pairing URL for App'}
            </button>

            <button
              onClick={() => setState('REJECTED')}
              className="btn-secondary"
              style={{ width: '100%', height: '38px', fontSize: '12px', color: '#94a3b8' }}
            >
              <XCircle size={14} /> Cancel Request
            </button>
          </div>
        </div>
      )}

      {state === 'CONNECTING' && (
        <div className="glass-panel" style={{ padding: '36px 24px', textAlign: 'center', maxWidth: '420px' }}>
          <Radio className="pulse" size={40} style={{ color: 'var(--accent-blue)', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '8px' }}>Establishing Peer Connection</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
            Securing WebRTC stream with the support operator...
          </p>
          <button onClick={() => stopSupportSession(true)} className="btn-secondary" style={{ fontSize: '13px' }}>
            Cancel Connection
          </button>
        </div>
      )}

      {state === 'STREAMING' && (
        <div className="glass-panel" style={{ width: '100%', maxWidth: '460px', padding: '28px 20px', textAlign: 'center' }}>
          <div style={{
            width: '56px',
            height: '56px',
            borderRadius: '50%',
            background: 'rgba(16, 185, 129, 0.15)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '16px',
            color: 'var(--accent-green)',
            border: '1px solid rgba(16, 185, 129, 0.3)'
          }}>
            {streamType === 'screen' ? <Monitor size={28} /> : <Camera size={28} />}
          </div>

          <span className="badge badge-active" style={{ marginBottom: '12px' }}>
            ● {streamType === 'screen' ? 'Screen Sharing Active' : 'Camera Stream Active'}
          </span>

          <h2 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '6px' }}>Remote Support Active</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
            Your stream is currently being transmitted to <strong>{operatorName}</strong>.
          </p>

          <div style={{
            background: 'rgba(0, 0, 0, 0.3)',
            borderRadius: '8px',
            padding: '12px',
            marginBottom: '24px',
            fontSize: '12px',
            color: 'var(--text-muted)',
            display: 'flex',
            justifyContent: 'space-around'
          }}>
            <span>Stream: {streamInfo.resolution}</span>
            <span>Target: {streamInfo.fps} FPS</span>
            <span>Encryption: DTLS-SRTP</span>
          </div>

          <button
            onClick={() => stopSupportSession(true)}
            className="btn-danger"
            style={{ width: '100%', height: '48px', fontSize: '15px' }}
          >
            <StopCircle size={20} /> STOP REMOTE SUPPORT
          </button>
        </div>
      )}

      {state === 'REJECTED' && (
        <div className="glass-panel" style={{ padding: '36px 24px', textAlign: 'center', maxWidth: '400px' }}>
          <XCircle size={44} style={{ color: 'var(--accent-red)', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '8px' }}>Request Cancelled</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            You declined the remote support session. No screen data was captured or shared.
          </p>
        </div>
      )}

      {state === 'ENDED' && (
        <div className="glass-panel" style={{ padding: '36px 24px', textAlign: 'center', maxWidth: '400px' }}>
          <CheckCircle size={44} style={{ color: '#94a3b8', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '8px' }}>SESSION ENDED</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            The remote support session has finished. Screen sharing and remote interaction have been stopped.
          </p>
        </div>
      )}

      {state === 'ERROR' && (
        <div className="glass-panel" style={{ padding: '36px 24px', textAlign: 'center', maxWidth: '400px' }}>
          <ShieldAlert size={44} style={{ color: 'var(--accent-red)', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '8px' }}>Session Unavailable</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
            {errorMessage || 'This remote support session is invalid, expired, or has ended.'}
          </p>
          <button onClick={() => window.location.reload()} className="btn-secondary" style={{ fontSize: '13px' }}>
            <RefreshCw size={14} /> Try Again
          </button>
        </div>
      )}
    </div>
  );
}
