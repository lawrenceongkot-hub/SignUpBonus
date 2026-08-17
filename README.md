# Production-Ready Remote Support System

A production-grade, enterprise remote-support platform featuring secure Admin API Key generation & management, Operator Dashboard with real-time WebRTC screen viewing & interaction controls, mobile pairing with explicit consent, MediaProjection screen streaming, standalone WebSocket signaling server, PostgreSQL + Prisma database, and a full native Kotlin Android companion application with AccessibilityService gesture injection.

---

## Key Features & Architecture

- **1. Operator Dashboard (`/`)**:
  - Secure server-side authenticated API key entry.
  - Generates short-lived pairing sessions (15-minute expiration) with cryptographically secure tokens.
  - Dynamic QR Code generation embedding temporary pairing URLs (`${PUBLIC_APP_URL}/pair/${sessionId}?token=${token}`).
  - **API keys are NEVER exposed inside QR codes or pairing URLs**.
  - Real-time WebRTC video screen viewer receiving live Android/browser MediaStream tracks.
  - Live diagnostics HUD: Resolution, FPS, Bitrate, RTT latency, Packet Loss via `peerConnection.getStats()`.
  - Authorized Remote Interaction Overlay: Click-to-Tap, Drag-to-Swipe, Mouse Scroll, Text Injection, and Android System Navigation (Back, Home, Recents) transmitted over authenticated `RTCDataChannel`.
  - Comprehensive [ STOP SESSION ] workflow: terminates WebRTC, closes DataChannel, marks session as ended in DB, and shows SESSION ENDED.

- **2. Admin API Key Authority (`/generateapi`)**:
  - Protected by server-side administrator credentials (`ADMIN_USERNAME` and `ADMIN_PASSWORD`).
  - Cryptographically secure 256-bit API key generator (`crypto.randomBytes`).
  - Raw API keys displayed once upon creation and stored exclusively as SHA-256 hashes.
  - Real-time key revocation table and audit logging.

- **3. Mobile Pairing & Consent Client (`/pair/[sessionId]`)**:
  - Explicit user consent screen: *"The support operator is requesting permission to view and interact with your device."*
  - Requires user to explicitly select [ Allow Remote Support ].
  - Browser-based screen capture via `navigator.mediaDevices.getDisplayMedia` with WebRTC streaming and on-screen ripple touch indicators.
  - Prominent [ STOP REMOTE SUPPORT ] button.

- **4. Native Android Companion App (`android-app/`)**:
  - Kotlin + Android SDK 34 project.
  - `MediaProjectionManager` screen capture with `ForegroundService` (type `mediaProjection`) and persistent notification banner.
  - Official WebRTC Android SDK (`org.webrtc`).
  - `AccessibilityService` (`dispatchGesture`) for authorized remote touch, swipe, scroll, and text injection.
  - Deep-link pairing URL handler (`https://.../pair/...`).

- **5. High-Throughput Standalone Signaling Server (`server/signaling.ts`)**:
  - WebSocket (`ws`) signaling server handling room routing, SDP offers/answers, ICE candidates, interaction events, and session keepalives.

- **6. Database & Persistence (`prisma/schema.prisma`)**:
  - PostgreSQL schema with Prisma ORM: `Operator`, `ApiKey`, `Session`, `Device`, `AuditLog`.

---

## Environment Variables

Configure the following in your `.env` or deployment settings:

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `PUBLIC_APP_URL` | Public production URL of the web dashboard | `https://support.example.com` |
| `DATABASE_URL` | PostgreSQL connection URL | `postgresql://user:pass@host:5432/db?schema=public` |
| `ADMIN_USERNAME` | Administrator username for `/generateapi` | `Admin` |
| `ADMIN_PASSWORD` | Administrator password for `/generateapi` | `Ryeon1121` |
| `NEXT_PUBLIC_WS_URL` | Public WebSocket URL for signaling server | `wss://signaling.example.com` (or `ws://localhost:8080` for dev) |
| `SIGNALING_PORT` | Port for standalone signaling server | `8080` |
| `TURN_SERVER_URL` | Optional TURN server URL (e.g. coturn) | `turn:turn.example.com:3478` |
| `TURN_USERNAME` | TURN server username | `support_turn_user` |
| `TURN_PASSWORD` | TURN server credential | `turn_secret_password` |

---

## Getting Started

### 1. Install Dependencies & Generate Prisma Client
```bash
npm install
npx prisma generate
```

### 2. Run Database Migrations
```bash
npx prisma db push
```

### 3. Start the Signaling Server
```bash
npm run signaling
```

### 4. Start Next.js Development Server
```bash
npm run dev
```

Visit `http://localhost:3000` for the Operator Dashboard, or `http://localhost:3000/generateapi` for the Admin Panel.

---

## Acceptance Testing Flow

1. **Admin Panel**:
   - Go to `/generateapi`.
   - Log in with `Admin` / `Ryeon1121`.
   - Click **Generate New API Key** and copy the generated key (`rs_live_...`).

2. **Operator Dashboard**:
   - Go to `/`.
   - Paste the API Key and click **Authenticate**.
   - Click **Create QR Code** to generate a short-lived pairing session.

3. **Mobile User**:
   - Scan the QR code or open the pairing URL on an Android device or browser.
   - Review the consent prompt: *"The support operator is requesting permission to view and interact with your device."*
   - Click **Allow Remote Support**.
   - Authorize screen sharing via the browser or Android system dialog.

4. **Live Screen Sharing & Remote Control**:
   - The operator PC receives the real live screen in the video viewer.
   - Click or drag on the video to dispatch remote touch gestures.
   - Use the text injection bar to type text into remote fields.
   - Click **STOP SESSION** on PC or **STOP REMOTE SUPPORT** on mobile to cleanly terminate the session.

---

## Production Deployment

- **Next.js Web App**: Deploy directly to **Vercel** with environment variables configured.
- **Signaling Server**: Deploy `server/signaling.ts` to **Railway**, **Render**, **Fly.io**, or **Docker**.
- **Android App**: Open `android-app/` in Android Studio and build the release APK.
