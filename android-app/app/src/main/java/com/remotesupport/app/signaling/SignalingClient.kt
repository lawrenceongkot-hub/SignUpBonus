package com.remotesupport.app.signaling

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
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
    private val serverUrl: String,
    private val sessionId: String,
    private val token: String,
    private val listener: SignalingListener
) {
    companion object {
        private const val TAG = "SignalingClient"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }

    private val gson = Gson()
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private var isUsingHttp = false
    private var lastMessageId = 0
    private var isPolling = false
    private val mainHandler = Handler(Looper.getMainLooper())

    private val pollRunnable = object : Runnable {
        override fun run() {
            if (!isPolling) return
            pollHttpSignaling()
            mainHandler.postDelayed(this, 600)
        }
    }

    fun connect() {
        val cleanUrl = serverUrl.trim()
        val isWs = cleanUrl.startsWith("ws://") || cleanUrl.startsWith("wss://")

        if (isWs && !cleanUrl.contains("vercel.app") && !cleanUrl.contains("signaling.example.com")) {
            try {
                Log.i(TAG, "Connecting to WebSocket: $cleanUrl")
                val request = Request.Builder().url(cleanUrl).build()
                webSocket = client.newWebSocket(request, object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        Log.i(TAG, "Signaling WebSocket connected")
                        val joinMsg = JsonObject().apply {
                            addProperty("type", "join")
                            addProperty("sessionId", sessionId)
                            addProperty("role", "device")
                            addProperty("token", token)
                        }
                        webSocket.send(gson.toJson(joinMsg))
                        mainHandler.post { listener.onJoined(sessionId) }
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        handleMessageJson(text)
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        Log.w(TAG, "WebSocket failed, falling back to HTTP serverless signaling", t)
                        startHttpPolling()
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        Log.i(TAG, "WebSocket closed: $reason")
                    }
                })
                return
            } catch (e: Exception) {
                Log.w(TAG, "WS connection error, falling back to HTTP", e)
            }
        }

        // Fallback to HTTP Serverless Signaling on Vercel
        startHttpPolling()
    }

    private fun getHttpBaseUrl(): String {
        var base = serverUrl.trim()
        if (base.startsWith("ws://")) base = "http://" + base.substring(5)
        if (base.startsWith("wss://")) base = "https://" + base.substring(6)
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            base = "https://$base"
        }
        return base.removeSuffix("/")
    }

    private fun startHttpPolling() {
        if (isPolling) return
        isUsingHttp = true
        isPolling = true
        Log.i(TAG, "Starting HTTP Serverless Signaling Polling for session: $sessionId")

        // Send initial join
        val joinBody = JsonObject().apply {
            addProperty("type", "join")
            addProperty("sessionId", sessionId)
            addProperty("role", "device")
            addProperty("token", token)
        }
        sendHttpPost(joinBody)

        mainHandler.post(pollRunnable)
        listener.onJoined(sessionId)
    }

    private fun pollHttpSignaling() {
        val url = "${getHttpBaseUrl()}/api/signaling/$sessionId?role=device&lastId=$lastMessageId"
        val request = Request.Builder().url(url).get().build()

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                // Ignore transient network errors
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (response.isSuccessful) {
                        val bodyStr = response.body?.string() ?: return
                        try {
                            val json = gson.fromJson(bodyStr, JsonObject::class.java)
                            val messages = json.getAsJsonArray("messages") ?: JsonArray()
                            for (elem in messages) {
                                val msg = elem.asJsonObject
                                val id = msg.get("id")?.asInt ?: 0
                                if (id > lastMessageId) {
                                    lastMessageId = id
                                    val type = msg.get("type")?.asString ?: ""
                                    val payload = msg.get("payload")?.asJsonObject
                                    dispatchMessage(type, payload)
                                }
                            }
                        } catch (e: Exception) {
                            Log.e(TAG, "Error parsing signaling JSON", e)
                        }
                    }
                }
            }
        })
    }

    private fun handleMessageJson(text: String) {
        try {
            val msg = gson.fromJson(text, JsonObject::class.java)
            val type = msg.get("type")?.asString ?: return
            val payload = msg.getAsJsonObject("payload") ?: msg
            dispatchMessage(type, payload)
        } catch (e: Exception) {
            Log.e(TAG, "Error handling message JSON", e)
        }
    }

    private fun dispatchMessage(type: String, payload: JsonObject?) {
        mainHandler.post {
            when (type) {
                "joined" -> listener.onJoined(sessionId)
                "offer" -> {
                    val sdp = payload?.getAsJsonObject("offer")?.get("sdp")?.asString
                        ?: payload?.get("sdp")?.asString ?: ""
                    if (sdp.isNotEmpty()) listener.onOfferReceived(sdp)
                }
                "answer" -> {
                    val sdp = payload?.getAsJsonObject("answer")?.get("sdp")?.asString
                        ?: payload?.get("sdp")?.asString ?: ""
                    if (sdp.isNotEmpty()) listener.onAnswerReceived(sdp)
                }
                "ice-candidate" -> {
                    val candidateObj = payload?.getAsJsonObject("candidate") ?: payload
                    if (candidateObj != null) {
                        listener.onIceCandidateReceived(candidateObj)
                    }
                }
                "interaction" -> {
                    if (payload != null) {
                        listener.onInteractionCommand(payload)
                    }
                }
                "session-stopped", "stop-session" -> listener.onSessionStopped()
            }
        }
    }

    private fun sendHttpPost(bodyObj: JsonObject) {
        val url = "${getHttpBaseUrl()}/api/signaling/$sessionId"
        val body = bodyObj.toString().toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder().url(url).post(body).build()

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.e(TAG, "Failed to send HTTP signaling message", e)
            }
            override fun onResponse(call: Call, response: Response) {
                response.close()
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
        if (webSocket != null && !isUsingHttp) {
            webSocket?.send(gson.toJson(msg))
        } else {
            sendHttpPost(msg)
        }
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
        if (webSocket != null && !isUsingHttp) {
            webSocket?.send(gson.toJson(msg))
        } else {
            sendHttpPost(msg)
        }
    }

    fun sendStopSession() {
        val msg = JsonObject().apply {
            addProperty("type", "stop-session")
            addProperty("sessionId", sessionId)
            addProperty("role", "device")
        }
        if (webSocket != null && !isUsingHttp) {
            webSocket?.send(gson.toJson(msg))
        } else {
            sendHttpPost(msg)
        }
    }

    fun disconnect() {
        isPolling = false
        mainHandler.removeCallbacks(pollRunnable)
        webSocket?.close(1000, "Device disconnected")
        webSocket = null
    }
}
