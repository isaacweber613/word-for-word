package com.kafkasl.phonewhisper

import android.content.Context
import android.util.Log
import kotlin.concurrent.thread

/**
 * One recording through the picked cloud model, and through another model when that one is busy
 * or down. Used for dictation and for audio files shared to the app (ShareActivity).
 */
object CloudTranscription {
    private const val TAG = "PhoneWhisper"
    const val NO_KEY = "Set your OpenRouter API key in the Word for Word app"

    /**
     * [text] is null when no words came back; [failure] is then the answer to report.
     * [unavailable] is the picked model when the backup model wrote the text instead.
     */
    class Outcome(val text: String?, val model: String, val unavailable: String?, val failure: TranscriberClient.Result?) {
        /** Says which model answered, when it wasn't the picked one. */
        val notice get() = unavailable?.let {
            "${TranscriberClient.titleFor(it)} was unavailable. Used ${TranscriberClient.titleFor(model)}."
        }
    }

    private fun prefs(context: Context) = context.getSharedPreferences("phonewhisper", Context.MODE_PRIVATE)

    /** False when there is no OpenRouter key and this build has no free minutes. */
    fun ready(context: Context) =
        !prefs(context).getString("api_key", "").isNullOrBlank() || FreeMinutes.inUse(context)

    /**
     * Opens the connection to the server the recording will go to, while the person is still
     * speaking, so the upload doesn't spend about a second on it after they stop (Isaac's
     * 2026-11-19 upload: 967 ms connecting before the first byte went out).
     */
    fun warm(context: Context) {
        if (ready(context)) TranscriberClient.warm(viaServer = FreeMinutes.inUse(context))
        // A phone with no device token yet gets one while the person speaks.
        FreeMinutes.registerSoon(context)
    }

    /**
     * [wav] is 16 kHz, 16-bit mono, as WavWriter makes it. [stream] has the same audio already
     * compressed while recording; without it the recording is compressed here.
     */
    fun run(context: Context, wav: ByteArray, stream: OggOpus.Stream? = null, callback: (Outcome) -> Unit) {
        val p = prefs(context)
        val apiKey = p.getString("api_key", "") ?: ""
        // With no key entered, the Play build (free minutes) or any build with an access code uses Word for Word's server.
        val deviceId = if (FreeMinutes.inUse(context)) FreeMinutes.deviceId(context) else null
        val accessCode = if (deviceId != null) Access.code(context) else null
        // With free minutes, Word for Word picks the model; the picker is hidden.
        val model = if (deviceId != null) TranscriberClient.DEFAULT_MODEL
                    else p.getString("cloud_model", TranscriberClient.DEFAULT_MODEL) ?: TranscriberClient.DEFAULT_MODEL
        val verbatim = p.getBoolean("verbatim", false)
        // With Yiddish picked, Yiddish audio goes to the Yiddish model; anything else lets the model guess.
        // Builds without Yiddish takes send Yiddish to the cloud model like any language (YiddishServer.available).
        val language = (p.getString("language", "auto") ?: "auto").let { if (it == "yi" && YiddishServer.available(p)) "auto" else it }
        // Audio length to a tenth of a second (32,000 bytes a second after the 44-byte header), for usage stats.
        val seconds = Math.round((wav.size - 44) / 3200.0) / 10.0

        // Built-in models take the much smaller Ogg Opus (see OggOpus); custom model IDs get WAV.
        // If a model refuses the Ogg audio (HTTP 400), the same recording goes again as WAV.
        val builtIn = TranscriberClient.CLOUD_MODELS.map { it.id }.toSet()
        var ogg: ByteArray? = null
        var compressMs = 0L
        var deviceToken: String? = null
        fun sendWav(m: String, cb: (TranscriberClient.Result) -> Unit) =
            TranscriberClient.transcribe(wav, apiKey, m, verbatim, language, deviceId, "wav", deviceToken, accessCode, cb)
        fun send(m: String, cb: (TranscriberClient.Result) -> Unit) {
            val small = ogg
            if (small == null || m !in builtIn) return sendWav(m, cb)
            TranscriberClient.transcribe(small, apiKey, m, verbatim, language, deviceId, "ogg", deviceToken, accessCode) { r ->
                if (r.code == 400) { Log.i(TAG, "$m refused Ogg audio; sending WAV"); sendWav(m, cb) } else cb(r)
            }
        }

        fun done(text: String, used: String, picked: String = model) {
            Analytics.track("transcribed", mapOf("model" to used, "seconds" to seconds,
                "backup_model" to (used != picked), "free_minutes" to (deviceId != null),
                // How long the phone took to shrink the recording before uploading it.
                "compress_ms" to compressMs))
            callback(Outcome(text, used, picked.takeIf { it != used }, null))
        }

        // Through Word for Word's server (free minutes or the subscription), the server picks the
        // model and tries its backups itself (Isaac's Models page). When the server says nothing is
        // left, the phone's Google Play purchases are sent again once, in case the subscription just
        // renewed or was bought on another phone, and the recording goes again if time is left.
        fun viaServer(result: TranscriberClient.Result, retried: Boolean) {
            if (result.errorCode == "device_unverified" && !retried) {
                // The server no longer takes this phone's device token: ask Google Play again, once.
                thread {
                    deviceToken = FreeMinutes.register(context, again = true)
                    if (deviceToken != null) send(model) { viaServer(it, true) } else callback(Outcome(null, model, null, result))
                }
            } else if (!result.text.isNullOrBlank()) {
                FreeMinutes.remember(context, out = false)
                done(result.text, result.servedBy ?: model, result.servedBy ?: model)
            } else if (result.errorCode in FreeMinutes.OUT_CODES) {
                FreeMinutes.noTimeLeft(context, result.errorCode)
                if (Billing.available && !retried) {
                    Billing.sync(context) { left ->
                        if (left) send(model) { viaServer(it, true) } else callback(Outcome(null, model, null, result))
                    }
                } else {
                    callback(Outcome(null, model, null, result))
                }
            } else {
                callback(Outcome(null, result.servedBy ?: model, null, result))
            }
        }

        // Compressing takes a moment, so it runs off the main thread; replies already come on OkHttp's.
        thread {
            val t = System.nanoTime()
            ogg = stream?.finish() ?: OggOpus.encode(wav)
            compressMs = (System.nanoTime() - t) / 1_000_000
            Log.i(TAG, "Compressed ${wav.size} bytes to ${ogg?.size ?: 0} in $compressMs ms")
            if (deviceId != null) {
                // Usually saved long ago; only the first recording on a phone waits for Google Play here.
                deviceToken = FreeMinutes.register(context)
                send(model) { viaServer(it, false) }
                return@thread
            }
            send(model) { result ->
                if (!result.text.isNullOrBlank()) {
                    done(result.text, model)
                } else if (TranscriberClient.shouldTryAnotherModel(result.code, result.detail)) {
                    // The chosen model is busy or down: send the same recording to another model right away.
                    val backup = TranscriberClient.fallbackFor(model)
                    Log.i(TAG, "$model failed (${result.code}), trying $backup")
                    send(backup) { second ->
                        Log.i(TAG, "$backup answered: ${if (!second.text.isNullOrBlank()) "text" else second.code?.let { "error $it" } ?: "no text"}")
                        if (!second.text.isNullOrBlank()) done(second.text, backup)
                        else callback(Outcome(null, model, null, if (second.error == null && second.text != null) second else result))
                    }
                } else {
                    callback(Outcome(null, model, null, result))
                }
            }
        }
    }

    /** Counts a failed transcription. True when the model answered but heard no words. */
    fun trackFailure(model: String, result: TranscriberClient.Result): Boolean {
        val heardNothing = result.error == null && result.text != null
        Analytics.track("transcription_failed", mapOf(
            "model" to model,
            "reason" to if (heardNothing) "no_words" else "error",
            "http_code" to (result.code ?: 0)))
        return heardNothing
    }
}
