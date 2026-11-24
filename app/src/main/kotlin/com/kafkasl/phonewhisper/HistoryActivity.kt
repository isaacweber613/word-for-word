package com.kafkasl.phonewhisper

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.text.format.DateUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.google.android.material.materialswitch.MaterialSwitch
import java.io.File

/**
 * Saved transcriptions. Tap one to copy it; long-press to delete it. An entry that kept its
 * recording (one that couldn't be typed, or every one with "Always save audio") can be played,
 * saved or shared.
 */
class HistoryActivity : AppCompatActivity() {

    private lateinit var list: LinearLayout
    private lateinit var empty: TextView
    private var player: MediaPlayer? = null
    /** The time of the entry whose recording is playing. */
    private var playing: Long? = null
    /** The recording waiting for the person to pick where to save it. */
    private var saving: File? = null
    private val saveAs = registerForActivityResult(ActivityResultContracts.CreateDocument("audio/*")) { uri ->
        val src = saving ?: return@registerForActivityResult
        saving = null
        if (uri != null) copyTo(src, uri)
    }

    private val dp get() = resources.displayMetrics.density
    private fun dp(v: Int) = (v * dp).toInt()

    private fun attrColor(attr: Int): Int {
        val tv = TypedValue(); theme.resolveAttribute(attr, tv, true)
        return if (tv.resourceId != 0) ContextCompat.getColor(this, tv.resourceId) else tv.data
    }

    private fun selectable(): android.graphics.drawable.Drawable? {
        val tv = TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true)
        return ContextCompat.getDrawable(this, tv.resourceId)
    }

    private fun prefs() = getSharedPreferences("phonewhisper", MODE_PRIVATE)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        root.addView(TextView(this).apply {
            text = "History"
            textSize = 32f
            setPadding(dp(24), dp(64), dp(24), dp(8))
        })
        root.addView(TextView(this).apply {
            text = "Tap a transcription to copy it. Long-press to delete it."
            textSize = 14f
            setTextColor(attrColor(android.R.attr.textColorSecondary))
            setPadding(dp(24), 0, dp(24), dp(16))
        })

        // Keep-forever switch
        val keepSwitch = switchRow(root, "Keep history forever", "Off: transcriptions are deleted after 24 hours",
            "keep_history_forever") { sw ->
            if (sw.isChecked && HistoryStore.all(this).isNotEmpty()) {
                android.app.AlertDialog.Builder(this)
                    .setTitle("Turn off keep forever?")
                    .setMessage("Transcriptions older than 24 hours will be deleted right away.")
                    .setPositiveButton("Turn off") { _, _ ->
                        prefs().edit().putBoolean("keep_history_forever", false).apply()
                        sw.isChecked = false
                        render()
                    }
                    .setNegativeButton("Cancel", null)
                    .show()
            } else {
                sw.isChecked = !sw.isChecked
                prefs().edit().putBoolean("keep_history_forever", sw.isChecked).apply()
                render()
            }
        }

        // Always save audio
        switchRow(root, "Always save audio", "Off: audio is saved only when a recording couldn't be typed",
            HistoryStore.ALWAYS_SAVE_AUDIO) { sw ->
            sw.isChecked = !sw.isChecked
            prefs().edit().putBoolean(HistoryStore.ALWAYS_SAVE_AUDIO, sw.isChecked).apply()
        }

        // Clear all
        root.addView(TextView(this).apply {
            text = "Clear all history"
            textSize = 16f
            setTextColor(attrColor(com.google.android.material.R.attr.colorPrimary))
            setPadding(dp(24), dp(12), dp(24), dp(12))
            background = selectable()
            isFocusable = true
            setOnClickListener {
                android.app.AlertDialog.Builder(this@HistoryActivity)
                    .setTitle("Clear all history?")
                    .setMessage("This deletes every saved transcription and recording.")
                    .setPositiveButton("Clear") { _, _ -> stopPlaying(); HistoryStore.clear(this@HistoryActivity); render() }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
        })

        empty = TextView(this).apply {
            text = "No transcriptions yet."
            textSize = 15f
            setTextColor(attrColor(android.R.attr.textColorSecondary))
            setPadding(dp(24), dp(24), dp(24), dp(24))
        }
        root.addView(empty)

        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(list)

        setContentView(ScrollView(this).apply {
            setBackgroundColor(attrColor(android.R.attr.colorBackground))
            addView(root)
            // Android 15+ draws apps under the status and navigation bars; pad so nothing hides behind them.
            clipToPadding = false
            androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(this) { v, insets ->
                val bars = insets.getInsets(
                    androidx.core.view.WindowInsetsCompat.Type.systemBars() or
                    androidx.core.view.WindowInsetsCompat.Type.displayCutout())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        })
    }

    override fun onResume() { super.onResume(); render() }

    override fun onPause() { super.onPause(); if (playing != null) { stopPlaying(); render() } }

    /** A settings row with a switch showing [pref]; [onTap] decides what a tap does. */
    private fun switchRow(root: LinearLayout, title: String, subtitle: String, pref: String,
                          onTap: (MaterialSwitch) -> Unit): MaterialSwitch {
        val sw = MaterialSwitch(this).apply { isChecked = prefs().getBoolean(pref, false); isClickable = false }
        val texts = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@HistoryActivity).apply { text = title; textSize = 18f })
            addView(TextView(this@HistoryActivity).apply {
                text = subtitle
                textSize = 14f
                setTextColor(attrColor(android.R.attr.textColorSecondary))
            })
        }
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(24), dp(12), dp(24), dp(12))
            background = selectable()
            isFocusable = true
            addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(sw)
            setOnClickListener { onTap(sw) }
        })
        return sw
    }

    private fun mimeOf(f: File) = if (f.extension == "ogg") "audio/ogg" else "audio/wav"

    private fun togglePlay(e: HistoryStore.Entry, f: File) {
        val wasThis = playing == e.time
        stopPlaying()
        if (!wasThis) try {
            player = MediaPlayer().apply {
                setDataSource(f.path)
                setOnCompletionListener { stopPlaying(); render() }
                prepare()
                start()
            }
            playing = e.time
        } catch (ex: Exception) {
            stopPlaying()
            Toast.makeText(this, "Couldn't play this recording", Toast.LENGTH_SHORT).show()
        }
        render()
    }

    private fun stopPlaying() {
        player?.release()
        player = null
        playing = null
    }

    private fun share(f: File) {
        val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
            type = mimeOf(f)
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }, null))
    }

    private fun copyTo(src: File, uri: Uri) {
        try {
            contentResolver.openOutputStream(uri)!!.use { out -> src.inputStream().use { it.copyTo(out) } }
            Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
        } catch (ex: Exception) {
            Toast.makeText(this, "Couldn't save the recording", Toast.LENGTH_SHORT).show()
        }
    }

    /** Flat text buttons under an entry: Play, Save, Share. */
    private fun audioActions(e: HistoryStore.Entry, f: File): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        fun action(label: String, onClick: () -> Unit) = addView(TextView(this@HistoryActivity).apply {
            text = label
            textSize = 15f
            setTextColor(attrColor(com.google.android.material.R.attr.colorPrimary))
            setPadding(0, dp(8), dp(24), dp(4))
            background = selectable()
            isFocusable = true
            setOnClickListener { onClick() }
        })
        action(if (playing == e.time) "Stop" else "Play") { togglePlay(e, f) }
        action("Save") {
            saving = f
            val stamp = java.text.SimpleDateFormat("yyyy-MM-dd HH.mm.ss", java.util.Locale.US).format(java.util.Date(e.time))
            saveAs.launch("Word for Word $stamp.${f.extension}")
        }
        action("Share") { share(f) }
    }

    private fun render() {
        list.removeAllViews()
        val entries = HistoryStore.all(this)
        empty.visibility = if (entries.isEmpty()) View.VISIBLE else View.GONE
        for (e in entries) {
            val whenText = DateUtils.getRelativeDateTimeString(
                this, e.time, DateUtils.MINUTE_IN_MILLIS, DateUtils.WEEK_IN_MILLIS, 0).toString()
            list.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(24), dp(12), dp(24), dp(12))
                background = selectable()
                isFocusable = true
                addView(TextView(this@HistoryActivity).apply {
                    text = whenText
                    textSize = 12f
                    setTextColor(attrColor(android.R.attr.textColorSecondary))
                })
                addView(TextView(this@HistoryActivity).apply {
                    if (e.text.isNotEmpty()) {
                        text = e.text
                    } else {
                        text = "Not typed: ${e.error ?: "the transcription failed"}"
                        setTextColor(attrColor(android.R.attr.textColorSecondary))
                    }
                    textSize = 16f
                    setTextIsSelectable(false)
                })
                HistoryStore.audioFile(this@HistoryActivity, e)?.let { addView(audioActions(e, it)) }
                setOnClickListener {
                    if (e.text.isEmpty()) return@setOnClickListener
                    (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                        .setPrimaryClip(ClipData.newPlainText("Transcription", e.text))
                    Toast.makeText(this@HistoryActivity, "Copied", Toast.LENGTH_SHORT).show()
                }
                setOnLongClickListener {
                    android.app.AlertDialog.Builder(this@HistoryActivity)
                        .setMessage(if (e.text.isEmpty()) "Delete this recording?" else "Delete this transcription?")
                        .setPositiveButton("Delete") { _, _ ->
                            if (playing == e.time) stopPlaying()
                            HistoryStore.delete(this@HistoryActivity, e)
                            render()
                        }
                        .setNegativeButton("Cancel", null)
                        .show()
                    true
                }
            })
        }
    }
}
