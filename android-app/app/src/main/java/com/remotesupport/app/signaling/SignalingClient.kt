package com.remotesupport.app.signaling

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import okhttp3.*
import java.util.concurrent.TimeUnit

interface SignalingListener {
    fun onJoined(sessionId: String)
    fun onOfferReceived(offerSdp: String)
    fun onAnswerReceived(answerSdp: String)
    fun onIceCandidateReceived(candidate: JsonObject)
    fun onInteractionCommand(command: JsonObject)
    fun onSessionStopped()
    fun onError(error: String)
}

class SignalingClient(
    private val wsUrl: String,
    private val sessionId: String,
    private val token: String,
    private val listener: SignalingListener
) {
    companion object {
        private const val TAG = "SignalingClient"
    }

    private val gson = Gson()
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    fun connect() {
        val request = Request.Builder().url(wsUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "Signaling WebSocket connected to: $wsUrl")
                val joinMsg = JsonObject().apply {
                    addProperty("type", "join")
                    addProperty("sessionId", sessionId)
                    addProperty("role", "device")
                    addProperty("token", token)
                }
                webSocket.send(gson.toJson(joinMsg))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val msg = gson.fromJson(text, JsonObject::class.java)
                    val type = msg.get("type")?.asString ?: return

                    when (type) {
                        "joined" -> listener.onJoined(sessionId)
                        "offer" -> {
                            val offerObj = msg.getAsJsonObject("offer")
                            val sdp = offerObj?.get("sdp")?.asString ?: ""
                            listener.onOfferReceived(sdp)
                        }
                        "answer" -> {
                            val answerObj = msg.getAsJsonObject("answer")
                            val sdp = answerObj?.get("sdp")?.asString ?: ""
                            listener.onAnswerReceived(sdp)
                        }
                        "ice-candidate" -> {
                            val candidateObj = msg.getAsJsonObject("candidate")
                            if (candidateObj != null) {
                                listener.onIceCandidateReceived(candidateObj)
                            }
                        }
                        "interaction" -> {
                            val payload = msg.getAsJsonObject("payload")
                            if (payload != null) {
                                listener.onInteractionCommand(payload)
                            }
                        }
                        "session-stopped" -> listener.onSessionStopped()
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error handling signaling message", e)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "Signaling WebSocket failure", t)
                listener.onError(t.message ?: "Signaling connection failure")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "Signaling WebSocket closed: $reason")
            }
        })
    }

    fun sendOffer(sdp: String) {
        val sdpObj = JsonObject().apply {
            addProperty("type", "offer")
            addProperty("sdp", sdp)
        }
        val msg = JsonObject().apply {
            addProperty("type", "offer")
            addProperty("sessionId", sessionId)
            addProperty("role", "device")
            add("offer", sdpObj)
        }
        webSocket?.send(gson.toJson(msg))
    }

    fun sendIceCandidate(sdpMid: String?, sdpMLineIndex: Int, sdp: String) {
        val candidateObj = JsonObject().apply {
            addProperty("sdpMid", sdpMid)
            addProperty("sdpMLineIndex", sdpMLineIndex)
            addProperty("candidate", sdp)
        }
        val msg = JsonObject().apply {
            addProperty("type", "ice-candidate")
            addProperty("sessionId", sessionId)
            addProperty("role", "device")
            add("candidate", candidateObj)
        }
        webSocket?.send(gson.toJson(msg))
    }

    fun sendStopSession() {
        val msg = JsonObject().apply {
            addProperty("type", "stop-session")
            addProperty("sessionId", sessionId)
            addProperty("role", "device")
        }
        webSocket?.send(gson.toJson(msg))
    }

    fun disconnect() {
        webSocket?.close(1000, "Device disconnected")
        webSocket = null
    }
}
