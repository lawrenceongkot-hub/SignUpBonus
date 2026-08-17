import { NextResponse } from 'next/server';
import { getWebRtcConfiguration } from '@/lib/webrtc-config';

export async function GET() {
  const config = getWebRtcConfiguration();
  return NextResponse.json(config);
}
