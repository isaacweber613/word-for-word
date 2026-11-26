package com.kafkasl.phonewhisper

import android.content.Context
import android.content.SharedPreferences
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Yiddish dictation (Isaac, 2026-11-08): with Yiddish picked as the language, holding the mic
 * button, or pressing the second (Yiddish) shortcut, sends that one recording to the Yiddish model
 * (ivrit.ai yi-whisper-large-v3) running on Isaac's PC, reached through the `yiddishtry` Cloudflare
 * Worker (yiddish-stt repo, tryout/). A normal tap keeps using the cloud model with Auto language.
 * Nothing changes unless Yiddish is the picked language.
 *
 * The PC keeps every take for training, in every build including Play. See PRIVACY.md.
 *
 * Isaac (2026-11-24): "I don't want everyone to be able to do that." Every take carries the
 * phone's ID and device token ([FreeMinutes.identify]), and the Worker asks Word for Word's server
 * (server/) whether the phone has time left, whatever OpenRouter key is typed, then counts the
 * take there. No phone is exempt. Builds not from Google Play get no device token, so they offer
 * these takes only with an access code (Access, 2026-11-24), which the server checks instead
 * ([available]); without one, Yiddish is a normal language for the cloud model there.
 */
object YiddishServer {
    private const val BASE = "https://yiddishtry.ynbsd6242.workers.dev"
    // The Worker's password for its try-it page; it gates the PC model and the saved takes.
    private const val PASSWORD = "4837"

    /** The Play build (free minutes and the subscription count these takes), or any build with an access code. */
    fun available(p: SharedPreferences) = FreeMinutes.available || Access.code(p) != null
    fun available(context: Context) = available(context.getSharedPreferences("phonewhisper", Context.MODE_PRIVATE))

    fun enabled(p: SharedPreferences) =
        available(p) && p.getString("language", "auto") == "yi"

    /** Pref: the person agreed to [DISCLOSURE]. */
    const val CONSENT = "yiddish_training_consent"
    const val DISCLOSURE = "Yiddish mode sends your recording through Cloudflare to a speech model on the developer's PC. " +
        "The PC keeps the recording and the text it typed to improve the Yiddish model, " +
        "with a random install ID and the app version. There is no automatic deletion. " +
        "If the PC is busy or off, the same model types it on the developer's cloud server (Modal), which keeps nothing. " +
        "If neither is available, your recording goes to OpenRouter and its speech provider instead, " +
        "through Word for Word's server when using free minutes. " +
        "A quick tap uses the normal cloud model without Yiddish training."

    /**
     * Google Play requires an in-app disclosure and an Agree tap before data is kept in a way
     * people don't expect, so the Play build asks once before the first Yiddish recording.
     * Isaac (2026-11-11): only what Play requires, and only in the Play build. The GitHub builds
     * don't ask, and there is no cloud-dictation question or settings row in any build.
     */
    fun needsConsent(p: SharedPreferences) = BuildConfig.FLAVOR == "play" && !p.getBoolean(CONSENT, false)

    /**
     * A random id for this install, for voice-disjoint training splits. It is not linked to the
     * person and is not the Android device id.
     */
    fun installId(context: Context): String {
        val p = context.getSharedPreferences("phonewhisper", Context.MODE_PRIVATE)
        p.getString("yiddish_install", null)?.let { return it }
        return UUID.randomUUID().toString().also { p.edit().putString("yiddish_install", it).apply() }
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    /**
     * Isaac (2026-11-19): when the PC is not free, the Worker sends a Yiddish take to the developer's cloud copy of the
     * same model instead, which takes 8 to 13 s to start. Called when a Yiddish recording starts and every
     * [WARM_EVERY_MS] while it goes on, so the start overlaps the recording; the Worker does nothing when the PC is
     * free. The cloud stops 15 s after its last request, hence every 10 s. The answer is not waited for.
     */
    const val WARM_EVERY_MS = 10_000L

    fun warm() {
        val request = Request.Builder()
            .url("$BASE/api/warm")
            .header("x-client", "app")
            .post(ByteArray(0).toRequestBody(null))
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}
            override fun onResponse(call: Call, response: Response) = response.close()
        })
    }

    /** Isaac (2026-11-08): when the PC with the Yiddish model is off, use the normal model (Auto). */
    const val OFF_NOTICE = "The Yiddish model is off. Used your normal model."

    /** True when the PC is off (the Worker answers 503) or the Worker can't be reached. */
    fun isOff(result: TranscriberClient.Result) =
        result.code == 503 || (result.code == null && result.error != null)

    /**
     * Every Yiddish take is kept on the PC for training. [source] is saved with the take: "app" for
     * dictation, "app-share" for an audio file shared to the app.
     */
    fun transcribe(context: Context, wav: ByteArray, appVersion: String, install: String, source: String = "app",
                   callback: (TranscriberClient.Result) -> Unit) {
        fun send(retried: Boolean) {
            val request = FreeMinutes.identify(Request.Builder(), context)
                .url("$BASE/api/transcribe")
                .header("x-password", PASSWORD)
                .header("x-client", source)
                .header("x-app-version", appVersion)
                .header("x-install", install)
                .post(wav.toRequestBody("audio/wav".toMediaType()))
                .build()
            client.newCall(request).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) = callback(offline(e))

                override fun onResponse(call: Call, response: Response) {
                    val body = response.body?.string() ?: ""
                    val json = try { JSONObject(body) } catch (_: Exception) { null }
                    val code = json?.optString("code").orEmpty()
                    when {
                        response.isSuccessful && json != null -> {
                            FreeMinutes.remember(context, out = false)
                            callback(TranscriberClient.Result(json.optString("text", ""), null))
                        }
                        // The server no longer takes this phone's device token: ask Google Play again, once.
                        code == "device_unverified" && !retried -> thread {
                            if (FreeMinutes.register(context, again = true) != null) send(true)
                            else callback(failure(context, response.code, json))
                        }
                        // Nothing left: send the Google Play purchases again once, in case the subscription just renewed.
                        // The server's answers to them say whether time is left (failure asks it otherwise).
                        code in OUT_CODES && !retried && Billing.available -> {
                            FreeMinutes.remember(context, out = true)
                            Billing.sync(context) { left -> if (left) send(true) else callback(failure(context, response.code, json)) }
                        }
                        else -> callback(failure(context, response.code, json))
                    }
                }
            })
        }
        // Usually saved long ago; only the first take on a phone waits for Google Play here.
        if (FreeMinutes.deviceToken(context) == null) thread { FreeMinutes.register(context); send(false) } else send(false)
    }

    /**
     * A shared file (Isaac, 2026-11-17): a 62-second video took the PC 150 s, and Cloudflare drops
     * a request that gets no answer for 125 s, so the take was typed out but the text never came
     * back. Like the try page, a shared file starts a job on the PC (POST /api/job) and asks for it
     * every 3 s (POST /api/job/status), or 5 s after a failed ask. Blocks; call it off the main
     * thread. [progress] gets how much of the file is typed out, 0 to 1, when the PC says.
     */
    fun transcribeJob(context: Context, wav: ByteArray, appVersion: String, install: String, source: String,
                      progress: (Double) -> Unit): TranscriberClient.Result {
        FreeMinutes.register(context)
        fun start() = FreeMinutes.identify(Request.Builder(), context)
            .url("$BASE/api/job")
            .header("x-password", PASSWORD)
            .header("x-client", source)
            .header("x-app-version", appVersion)
            .header("x-install", install)
            .post(wav.toRequestBody("audio/wav".toMediaType()))
            .build()
        var job: String? = null
        var retried = false
        while (job == null) {
            try {
                client.newCall(start()).execute().use { response ->
                    val json = try { JSONObject(response.body?.string() ?: "") } catch (_: Exception) { null }
                    job = json?.optString("job")?.takeIf { response.isSuccessful && it.isNotBlank() }
                    // The server no longer takes this phone's device token: ask Google Play again, once.
                    if (job == null && !(json?.optString("code") == "device_unverified" && !retried &&
                            FreeMinutes.register(context, again = true) != null)) return failure(context, response.code, json)
                    retried = true
                }
            } catch (e: IOException) {
                return offline(e)
            }
        }
        var wait = 3000L
        while (true) {
            Thread.sleep(wait)
            val ask = Request.Builder()
                .url("$BASE/api/job/status")
                .header("x-password", PASSWORD)
                .post(JSONObject().put("job", job).toString().toRequestBody("application/json".toMediaType()))
                .build()
            val json = try {
                client.newCall(ask).execute().use { response ->
                    val json = try { JSONObject(response.body?.string() ?: "") } catch (_: Exception) { null }
                    if (!response.isSuccessful || json == null) return failure(context, response.code, json)
                    json
                }
            } catch (_: IOException) {
                wait = 5000L
                continue
            }
            wait = 3000L
            if (!json.optBoolean("done")) {
                if (json.has("progress")) progress(json.optDouble("progress"))
                continue
            }
            if (json.optString("error").isNotBlank()) return failure(context, 500, json)
            return TranscriberClient.Result(json.optString("text", ""), null)
        }
    }

    private fun offline(e: IOException) = TranscriberClient.Result(null,
        if (e is java.net.UnknownHostException) "No internet connection. Your words weren't sent."
        else "Couldn't reach the Yiddish model. Try again.")

    /** Word for Word's server's answers when nothing is left (server/src/index.ts yiddishCheck). */
    private val OUT_CODES = setOf("free_minutes_used", "hours_used", "given_hours_used")

    private fun failure(context: Context, code: Int, json: JSONObject?): TranscriberClient.Result {
        val errorCode = json?.optString("code").orEmpty()
        // The server refuses a take that doesn't fit what is left (it holds a take's whole length first), so this
        // doesn't mean nothing is left: its own answer says (third review, 2026-11-25: marking the phone out here
        // stopped every Yiddish take until the app asked the server again).
        if (errorCode in OUT_CODES) FreeMinutes.usage(context) { }
        val msg = when {
            code == 503 -> "The Yiddish model is offline right now (the computer running it is off)."
            errorCode == "free_minutes_used" -> FreeMinutes.OUT_FREE
            errorCode == "hours_used" -> FreeMinutes.OUT_HOURS
            errorCode == "given_hours_used" -> FreeMinutes.OUT_GIVEN
            errorCode == "device_unverified" ->
                "Yiddish works only in Word for Word from Google Play, on a phone that passes Google Play's checks."
            else -> "The Yiddish model had a problem (${json?.optString("error")?.takeIf { it.isNotBlank() } ?: code}). Try again."
        }
        return TranscriberClient.Result(null, msg, code, errorCode = errorCode.ifBlank { null })
    }

}
