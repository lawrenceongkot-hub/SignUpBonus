package com.remotesupport.app

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.gson.JsonObject
import com.remotesupport.app.signaling.SignalingClient
import com.remotesupport.app.signaling.SignalingListener
import com.remotesupport.app.webrtc.WebRtcClient
import com.remotesupport.app.webrtc.WebRtcEventListener
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection

class RemoteSupportService : Service(), SignalingListener, WebRtcEventListener {

    companion object {
        private const val TAG = "RemoteSupportService"
        const val CHANNEL_ID = "RemoteSupportChannel"
        const val NOTIFICATION_ID = 1001

        const val ACTION_START_SUPPORT = "com.remotesupport.app.START_SUPPORT"
        const val ACTION_STOP_SUPPORT = "com.remotesupport.app.STOP_SUPPORT"

        const val EXTRA_PROJECTION_DATA = "extra_projection_data"
        const val EXTRA_SESSION_ID = "extra_session_id"
        const val EXTRA_TOKEN = "extra_token"
        const val EXTRA_WS_URL = "extra_ws_url"

        var isRunning = false
            private set
    }

    private var signalingClient: SignalingClient? = null
    private var webRtcClient: WebRtcClient? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) return START_NOT_STICKY

        val action = intent.action
        if (action == ACTION_STOP_SUPPORT) {
            stopSupport()
            return START_NOT_STICKY
        }

        if (action == ACTION_START_SUPPORT) {
            val projectionData: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(EXTRA_PROJECTION_DATA, Intent::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(EXTRA_PROJECTION_DATA)
            }

            val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: ""
            val token = intent.getStringExtra(EXTRA_TOKEN) ?: ""
            val wsUrl = intent.getStringExtra(EXTRA_WS_URL) ?: "wss://signaling.example.com"

            if (projectionData != null && sessionId.isNotEmpty() && token.isNotEmpty()) {
                startForegroundWithNotification()
                initSupportSession(projectionData, sessionId, token, wsUrl)
            } else {
                Log.e(TAG, "Missing parameters for remote support service.")
                stopSelf()
            }
        }

        return START_NOT_STICKY
    }

    private fun startForegroundWithNotification() {
        val stopIntent = Intent(this, RemoteSupportService::class.java).apply {
            action = ACTION_STOP_SUPPORT
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            0,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Remote Support Active")
            .setContentText("Your screen is being shared with the support operator.")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop Support", stopPendingIntent)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        isRunning = true
    }

    private fun initSupportSession(
        projectionData: Intent,
        sessionId: String,
        token: String,
        wsUrl: String
    ) {
        // Initialize WebRTC Client
        webRtcClient = WebRtcClient(this, this)
        webRtcClient?.startScreenCapture(projectionData)

        val iceServers = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
        )
        webRtcClient?.createPeerConnection(iceServers)

        // Initialize Signaling Client
        signalingClient = SignalingClient(wsUrl, sessionId, token, this)
        signalingClient?.connect()
    }

    // Signaling Listener Callbacks
    override fun onJoined(sessionId: String) {
        Log.i(TAG, "Device joined session room: $sessionId")
    }

    override fun onOfferReceived(offerSdp: String) {
        // Handled if operator sends offer
    }

    override fun onAnswerReceived(answerSdp: String) {
        webRtcClient?.setRemoteAnswer(answerSdp)
    }

    override fun onIceCandidateReceived(candidate: JsonObject) {
        val sdpMid = candidate.get("sdpMid")?.asString
        val sdpMLineIndex = candidate.get("sdpMLineIndex")?.asInt ?: 0
        val sdp = candidate.get("candidate")?.asString ?: ""
        webRtcClient?.addIceCandidate(IceCandidate(sdpMid, sdpMLineIndex, sdp))
    }

    override fun onInteractionCommand(command: JsonObject) {
        handleRemoteInteraction(command)
    }

    override fun onSessionStopped() {
        stopSupport()
    }

    override fun onError(error: String) {
        Log.e(TAG, "Signaling Error: $error")
    }

    // WebRTC Event Listener Callbacks
    override fun onIceCandidateGenerated(candidate: IceCandidate) {
        signalingClient?.sendIceCandidate(candidate.sdpMid, candidate.sdpMLineIndex, candidate.sdp)
    }

    override fun onDataChannelCommand(command: JsonObject) {
        handleRemoteInteraction(command)
    }

    override fun onConnectionState(state: PeerConnection.IceConnectionState) {
        if (state == PeerConnection.IceConnectionState.DISCONNECTED ||
            state == PeerConnection.IceConnectionState.FAILED ||
            state == PeerConnection.IceConnectionState.CLOSED
        ) {
            stopSupport()
        }
    }

    private fun handleRemoteInteraction(command: JsonObject) {
        val type = command.get("type")?.asString ?: return
        val a11y = RemoteAccessibilityService.instance

        if (a11y == null) {
            Log.w(TAG, "Accessibility service not running or authorized.")
            return
        }

        when (type) {
            "tap", "click" -> {
                val x = command.get("x")?.asFloat ?: 0.5f
                val y = command.get("y")?.asFloat ?: 0.5f
                a11y.dispatchTap(x, y)
            }
            "swipe" -> {
                val startX = command.get("startX")?.asFloat ?: 0.5f
                val startY = command.get("startY")?.asFloat ?: 0.5f
                val endX = command.get("endX")?.asFloat ?: 0.5f
                val endY = command.get("endY")?.asFloat ?: 0.5f
                val duration = command.get("duration")?.asLong ?: 300L
                a11y.dispatchSwipe(startX, startY, endX, endY, duration)
            }
            "scroll" -> {
                val deltaX = command.get("deltaX")?.asFloat ?: 0f
                val deltaY = command.get("deltaY")?.asFloat ?: 0f
                a11y.dispatchScroll(deltaX, deltaY)
            }
            "text" -> {
                val text = command.get("text")?.asString ?: ""
                a11y.injectText(text)
            }
            "key" -> {
                val key = command.get("key")?.asString ?: ""
                a11y.performNavigation(key)
            }
        }
    }

    private fun stopSupport() {
        isRunning = false
        signalingClient?.sendStopSession()
        signalingClient?.disconnect()
        signalingClient = null

        webRtcClient?.stop()
        webRtcClient = null

        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        super.onDestroy()
        stopSupport()
        Log.i(TAG, "RemoteSupportService destroyed.")
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Remote Support Active Session",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows active remote screen sharing status"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }
}
