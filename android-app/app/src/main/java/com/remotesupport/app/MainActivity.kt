package com.remotesupport.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var tvSessionStatus: TextView
    private lateinit var etPairingUrl: EditText
    private lateinit var btnAllowSupport: Button
    private lateinit var btnStopSupport: Button

    private lateinit var mediaProjectionManager: MediaProjectionManager

    private val screenCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            startSupportService(result.data!!)
        } else {
            Toast.makeText(this, "Screen capture permission was cancelled.", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        mediaProjectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager

        tvSessionStatus = findViewById(R.id.tvSessionStatus)
        etPairingUrl = findViewById(R.id.etPairingUrl)
        btnAllowSupport = findViewById(R.id.btnAllowSupport)
        btnStopSupport = findViewById(R.id.btnStopSupport)

        btnAllowSupport.setOnClickListener {
            requestScreenCapture()
        }

        btnStopSupport.setOnClickListener {
            stopSupportService()
        }

        handleIncomingIntent(intent)
        updateUiState()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun handleIncomingIntent(intent: Intent?) {
        val data: Uri? = intent?.data
        if (data != null) {
            etPairingUrl.setText(data.toString())

            // Automatically trigger Android MediaProjection permission request
            if (!RemoteSupportService.isRunning) {
                requestScreenCapture()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        updateUiState()
    }

    private fun updateUiState() {
        if (RemoteSupportService.isRunning) {
            tvSessionStatus.text = "Screen Sharing & Support Active"
            tvSessionStatus.setTextColor(getColor(R.color.success))
            btnAllowSupport.visibility = View.GONE
            btnStopSupport.visibility = View.VISIBLE
        } else {
            tvSessionStatus.text = "Ready for Pairing"
            tvSessionStatus.setTextColor(getColor(R.color.text_primary))
            btnAllowSupport.visibility = View.VISIBLE
            btnStopSupport.visibility = View.GONE
        }
    }

    private fun requestScreenCapture() {
        val captureIntent = mediaProjectionManager.createScreenCaptureIntent()
        screenCaptureLauncher.launch(captureIntent)
    }

    private fun startSupportService(projectionData: Intent) {
        val pairingUrl = etPairingUrl.text.toString().trim()
        val uri = Uri.parse(pairingUrl)
        val sessionId = uri.getQueryParameter("session") ?: uri.lastPathSegment ?: ""
        val token = uri.getQueryParameter("token") ?: ""

        val serverHost = if (uri.scheme == "remotesupport") {
            "https://sign-up-bonus.vercel.app"
        } else {
            "${uri.scheme}://${uri.host}"
        }

        val serviceIntent = Intent(this, RemoteSupportService::class.java).apply {
            action = RemoteSupportService.ACTION_START_SUPPORT
            putExtra(RemoteSupportService.EXTRA_PROJECTION_DATA, projectionData)
            putExtra(RemoteSupportService.EXTRA_SESSION_ID, sessionId)
            putExtra(RemoteSupportService.EXTRA_TOKEN, token)
            putExtra(RemoteSupportService.EXTRA_WS_URL, serverHost)
        }

        startForegroundService(serviceIntent)
        updateUiState()
        Toast.makeText(this, "Remote screen sharing started.", Toast.LENGTH_SHORT).show()
    }

    private fun stopSupportService() {
        val serviceIntent = Intent(this, RemoteSupportService::class.java).apply {
            action = RemoteSupportService.ACTION_STOP_SUPPORT
        }
        startService(serviceIntent)
        updateUiState()
        Toast.makeText(this, "Remote support stopped.", Toast.LENGTH_SHORT).show()
    }
}
