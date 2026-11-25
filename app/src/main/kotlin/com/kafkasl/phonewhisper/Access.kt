package com.kafkasl.phonewhisper

import android.content.Context
import android.content.SharedPreferences
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException

/**
 * Hours given without a subscription (Isaac, 2026-11-24: "Make me a way to give access, for people,
 * without subscribing"). Isaac gives a person hours a month, or unlimited, on his own web page, and
 * each person gets an access code (server/src/index.ts). The Play build gets the code by signing in
 * with Google ([GoogleAccount]), so it goes by the Google email; the GitHub builds take it typed in
 * Settings. With a code, recordings with no OpenRouter key go to Word for Word's server in every build,
 * and the code is sent with each one (X-Access-Code), so the given hours are used first.
 */
object Access {
    private const val CODE = "access_code"
    private const val WHO = "access_who"

    private fun prefs(context: Context) = context.getSharedPreferences("phonewhisper", Context.MODE_PRIVATE)

    fun code(p: SharedPreferences): String? = p.getString(CODE, null)?.takeIf { it.isNotBlank() }
    fun code(context: Context) = code(prefs(context))

    /** Whose hours this phone uses: the Google email, or the name on the page. */
    fun who(context: Context): String? = prefs(context).getString(WHO, null)

    fun clear(context: Context) = prefs(context).edit().remove(CODE).remove(WHO).apply()

    private fun save(context: Context, code: String, who: String) =
        prefs(context).edit().putString(CODE, code).putString(WHO, who).apply()

    /** A code as typed: letters and digits only, any case, dashes and spaces ignored. Null if it can't be one. */
    fun normalize(raw: String): String? =
        raw.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }.takeIf { it.length == 12 }

    private val http by lazy { OkHttpClient() }
    private val json = "application/json".toMediaType()

    /** [who] when the code is now in use, else [error] to show. Called back off the main thread. */
    class Answer(val who: String?, val error: String?)

    /** GitHub builds: checks a typed code with the server and keeps it when it's good. */
    fun useCode(context: Context, raw: String, callback: (Answer) -> Unit) {
        val code = normalize(raw) ?: return callback(Answer(null, "An access code has 12 letters and numbers."))
        val request = Request.Builder().url(BuildConfig.SERVICE_URL + "/v1/usage")
            .header("X-Device-Id", FreeMinutes.deviceId(context)).header("X-Access-Code", code).get().build()
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = callback(Answer(null, "Couldn't reach the server. Try again."))
            override fun onResponse(call: Call, response: Response) {
                val access = try { JSONObject(response.body?.string() ?: "").optJSONObject("access") } catch (e: Exception) { null }
                if (access == null) return callback(Answer(null, "That code doesn't work. Check it, or ask for a new one."))
                val who = access.optString("who")
                save(context, code, who)
                callback(Answer(who, null))
            }
        })
    }

    /** Play build: the ID token from signing in with Google; the server answers the code for hours given to that email. */
    fun useGoogle(context: Context, idToken: String, callback: (Answer) -> Unit) {
        val request = Request.Builder().url(BuildConfig.SERVICE_URL + "/v1/access/google")
            .post(JSONObject().put("id_token", idToken).toString().toRequestBody(json)).build()
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = callback(Answer(null, "Couldn't reach the server. Try again."))
            override fun onResponse(call: Call, response: Response) {
                val body = try { JSONObject(response.body?.string() ?: "") } catch (e: Exception) { JSONObject() }
                val code = body.optString("code")
                if (response.isSuccessful && code.isNotEmpty()) {
                    val who = body.optString("who")
                    save(context, code, who)
                    callback(Answer(who, null))
                } else {
                    callback(Answer(null, body.optJSONObject("error")?.optString("message")?.takeIf { it.isNotBlank() }
                        ?: "Signing in didn't work. Try again."))
                }
            }
        })
    }
}
