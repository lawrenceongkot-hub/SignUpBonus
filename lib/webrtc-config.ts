/**
 * WebRTC Configuration Provider
 * Configures ICE servers (STUN/TURN) based on production environment variables.
 */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface WebRtcConfiguration {
  iceServers: IceServerConfig[];
  iceCandidatePoolSize?: number;
  sdpSemantics?: 'unified-plan';
  bundlePolicy?: 'max-bundle';
}

export function getWebRtcConfiguration(): WebRtcConfiguration {
  const iceServers: IceServerConfig[] = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
  ];

  // If a dedicated production TURN server is configured (e.g. Coturn / Twilio / Xirsys)
  const turnUrl = process.env.TURN_SERVER_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnPassword = process.env.TURN_PASSWORD;

  if (turnUrl) {
    const urls = turnUrl.includes(',') ? turnUrl.split(',').map((u) => u.trim()) : turnUrl;
    const turnConfig: IceServerConfig = { urls };

    if (turnUsername && turnPassword) {
      turnConfig.username = turnUsername;
      turnConfig.credential = turnPassword;
    }

    iceServers.push(turnConfig);
  }

  return {
    iceServers,
    iceCandidatePoolSize: 10,
    sdpSemantics: 'unified-plan',
    bundlePolicy: 'max-bundle',
  };
}
