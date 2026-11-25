package com.kafkasl.phonewhisper

import android.annotation.SuppressLint
import android.content.Context
import android.provider.Settings
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * Free minutes in the Play Store build (Isaac, 2026-11-06: 30 a month, Play build only).
 * With no OpenRouter key entered, recordings go to Word for Word's server (`server/` in this
 * repo), which holds an OpenRouter key and counts each phone's minutes. GitHub builds get no free
 * minutes; they use the server only with an access code (Access), else the person's own key.
 */
object FreeMinutes {
    /** The Play build: free minutes, the subscription, and Google Play's word for the phone. */
    val available get() = BuildConfig.FLAVOR == "play"

    /** True when recordings go to Word for Word's server: no key entered, and free minutes or an access code. */
    fun inUse(context: Context) = apiKey(context).isBlank() && (available || Access.code(context) != null)

    /**
     * Identifies the phone to the server without saying who it is: a hash of Android's ID for
     * this app, which stays the same if the app is reinstalled.
     */
    @SuppressLint("HardwareIds")
    fun deviceId(context: Context): String {
        val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
        val digest = MessageDigest.getInstance("SHA-256").digest("word-for-word:$androidId".toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }

    // --- Play Integrity (Isaac, 2026-11-22): the server serves only the real Play app ---

    /** The token the server gave this phone once Google Play vouched for it (server/src/index.ts). */
    fun deviceToken(context: Context): String? = prefs(context).getString("device_token", null)

    /** Puts this phone's ID, its device token once it has one, and its access code (Access) on a request to the server. */
    fun identify(builder: Request.Builder, context: Context): Request.Builder = builder.apply {
        header("X-Device-Id", deviceId(context))
        deviceToken(context)?.let { header("X-Device-Token", it) }
        Access.code(context)?.let { header("X-Access-Code", it) }
    }

    /** True once the server said Google Play doesn't vouch for this phone, until the app restarts. */
    @Volatile private var refused = false
    private val registering = Any()

    /**
     * Registers in the background when this phone has no device token yet (at app start and when
     * recording starts). Also with the person's own key: Yiddish takes need the token whatever key
     * is typed (YiddishServer).
     */
    fun registerSoon(context: Context) {
        if (available && !BuildConfig.DEBUG && deviceToken(context) == null && !refused) thread { register(context) }
    }

    /**
     * This phone's device token, asking Google Play to vouch for the phone first when it has
     * none, or when [again] because the server stopped accepting it. Null when that failed.
     * Blocks, so never call it on the main thread. Runs once per install, not per recording.
     */
    fun register(context: Context, again: Boolean = false): String? {
        // Google Play never vouches for a debug build, so it doesn't ask (and doesn't slow the speed test).
        if (!available || BuildConfig.DEBUG) return null
        if (!again) deviceToken(context)?.let { return it }
        synchronized(registering) {
            if (!again) deviceToken(context)?.let { return it }
            if (refused) return null
            val id = deviceId(context)
            android.util.Log.i("PhoneWhisper", "No device token yet: asking Google Play to vouch for this phone")
            val integrity = Integrity.token(context, id)
            if (integrity == null) { Analytics.track("device_check", mapOf("result" to "no_play_token")); return null }
            val request = Request.Builder().url(BuildConfig.SERVICE_URL + "/v1/register").header("X-Device-Id", id)
                .post(JSONObject().put("integrity_token", integrity).toString().toRequestBody("application/json".toMediaType()))
                .build()
            return try {
                http.newCall(request).execute().use { r ->
                    val body = r.body?.string() ?: ""
                    val token = try { JSONObject(body).optString("device_token") } catch (e: Exception) { "" }
                    when {
                        r.isSuccessful && token.isNotEmpty() -> {
                            prefs(context).edit().putString("device_token", token).apply()
                            Analytics.track("device_check", mapOf("result" to "ok"))
                            token
                        }
                        else -> {
                            if (r.code == 403) refused = true
                            Analytics.track("device_check", mapOf("result" to if (r.code == 403) "refused" else "server_error",
                                "http_code" to r.code))
                            null
                        }
                    }
                }
            } catch (e: IOException) { null }
        }
    }

    data class Usage(val usedSeconds: Double, val freeSeconds: Double, val subscribed: Boolean, val out: Boolean)

    private val http by lazy { OkHttpClient() }

    /** Asks the server how much of this month's free time is used. Calls back with null on failure. */
    fun usage(context: Context, callback: (Usage?) -> Unit) { thread {
        register(context)
        val request = identify(Request.Builder().url(BuildConfig.SERVICE_URL + "/v1/usage"), context).get().build()
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = callback(null)
            override fun onResponse(call: Call, response: Response) {
                val body = response.body?.string()
                // The code was removed on the access page: stop sending it.
                try { if (response.isSuccessful && JSONObject(body ?: "").let { it.has("access") && it.isNull("access") }) Access.clear(context) }
                catch (e: Exception) { }
                val usage = try {
                    if (!response.isSuccessful || body == null) null
                    else JSONObject(body).let {
                        Usage(it.getDouble("used_seconds"), it.getDouble("free_seconds"),
                            it.optBoolean("subscribed"), it.optBoolean("out"))
                    }
                } catch (e: Exception) { null }
                usage?.let { remember(context, it.subscribed, it.out) }
                callback(usage)
            }
        })
    } }

    // --- The paid plan (Isaac, 2026-11-20): $3 a month for 10 hours, $1 for 4 more hours ---

    const val OUT_FREE = "You've used this month's free minutes. Subscribe in Word for Word to keep going: 10 hours a month for \$3."
    const val OUT_HOURS = "You've used this month's hours. Add 4 more hours for \$1 in Word for Word."
    /** Hours given on the access page, used up (server code given_hours_used). */
    const val OUT_GIVEN = "You've used this month's hours. They start again on the 1st."

    /** What the server last said: whether this phone has the subscription. */
    fun subscribed(context: Context) = prefs(context).getBoolean("plan_subscribed", false)

    /** True when the server last said nothing is left this month. A new month starts fresh. */
    fun out(context: Context) = prefs(context).getBoolean("plan_out", false) &&
        prefs(context).getString("plan_out_month", "") == month()

    fun outMessage(context: Context) = when {
        subscribed(context) -> OUT_HOURS
        Access.code(context) != null -> OUT_GIVEN
        else -> OUT_FREE
    }

    fun remember(context: Context, subscribed: Boolean? = null, out: Boolean? = null) {
        val e = prefs(context).edit()
        subscribed?.let { e.putBoolean("plan_subscribed", it) }
        out?.let { e.putBoolean("plan_out", it).putString("plan_out_month", month()) }
        e.apply()
    }

    private fun month() = java.text.SimpleDateFormat("yyyy-MM", java.util.Locale.US)
        .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date())

    private fun prefs(context: Context) = context.getSharedPreferences("phonewhisper", Context.MODE_PRIVATE)

    private fun apiKey(context: Context) =
        context.getSharedPreferences("phonewhisper", Context.MODE_PRIVATE).getString("api_key", "") ?: ""
}
