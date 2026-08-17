package com.remotesupport.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
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
            Toast.makeText(this, "Screen capture permission was denied.", Toast.LENGTH_LONG).show()
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

        // Handle incoming deep link pairing URL
        handleIntent(intent)

        btnAllowSupport.setOnClickListener {
            showConsentDialog()
        }

        btnStopSupport.setOnClickListener {
            stopSupportService()
        }

        updateUiState()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val data: Uri? = intent?.data
        if (data != null) {
            etPairingUrl.setText(data.toString())
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

    private fun showConsentDialog() {
        val pairingUrl = etPairingUrl.text.toString().trim()
        if (pairingUrl.isEmpty()) {
            Toast.makeText(this, "Please enter or scan a valid pairing URL.", Toast.LENGTH_SHORT).show()
            return
        }

        AlertDialog.Builder(this)
            .setTitle("Remote Support Request")
            .setMessage("The support operator is requesting permission to view and interact with your device. Do you allow remote support?")
            .setPositiveButton("Allow Remote Support") { _, _ ->
                checkAccessibilityAndStartCapture()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun checkAccessibilityAndStartCapture() {
        // Optional prompt to enable accessibility for full remote interaction
        if (!RemoteAccessibilityService.isServiceRunning) {
            AlertDialog.Builder(this)
                .setTitle("Enable Remote Interaction")
                .setMessage("To allow the operator to tap and interact with your device remotely, please enable 'Remote Support' in Accessibility Settings.")
                .setPositiveButton("Open Settings") { _, _ ->
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                }
                .setNegativeButton("Continue Screen-Only") { _, _ ->
                    requestScreenCapture()
                }
                .show()
        } else {
            requestScreenCapture()
        }
    }

    private fun requestScreenCapture() {
        val captureIntent = mediaProjectionManager.createScreenCaptureIntent()
        screenCaptureLauncher.launch(captureIntent)
    }

    private fun startSupportService(projectionData: Intent) {
        val pairingUrl = etPairingUrl.text.toString().trim()
        val uri = Uri.parse(pairingUrl)
        val sessionId = uri.lastPathSegment ?: ""
        val token = uri.getQueryParameter("token") ?: ""

        val serviceIntent = Intent(this, RemoteSupportService::class.java).apply {
            action = RemoteSupportService.ACTION_START_SUPPORT
            putExtra(RemoteSupportService.EXTRA_PROJECTION_DATA, projectionData)
            putExtra(RemoteSupportService.EXTRA_SESSION_ID, sessionId)
            putExtra(RemoteSupportService.EXTRA_TOKEN, token)
        }

        startForegroundService(serviceIntent)
        updateUiState()
        Toast.makeText(this, "Remote support started.", Toast.LENGTH_SHORT).show()
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
