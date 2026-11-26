package com.kafkasl.phonewhisper

import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * Export and import of every setting in the app's "phonewhisper" preferences, including the
 * OpenRouter API key, as a JSON file. Each value keeps its type so an import restores it exactly.
 */
object SettingsBackup {
    private const val FORMAT = "word-for-word-settings"

    fun export(values: Map<String, *>): String {
        val settings = JSONObject()
        for ((key, value) in values.toSortedMap()) {
            val entry = when (value) {
                is Boolean -> JSONObject().put("type", "boolean").put("value", value)
                is String -> JSONObject().put("type", "string").put("value", value)
                is Int -> JSONObject().put("type", "int").put("value", value)
                is Long -> JSONObject().put("type", "long").put("value", value)
                is Float -> JSONObject().put("type", "float").put("value", value.toDouble())
                is Set<*> -> JSONObject().put("type", "stringSet").put("value", JSONArray(value.map { it.toString() }.sorted()))
                else -> null
            } ?: continue
            settings.put(key, entry)
        }
        return JSONObject().put("format", FORMAT).put("version", 1).put("settings", settings).toString(2)
    }

    /** The settings in an exported file, or null when the file isn't a Word for Word settings file. */
    fun parse(json: String): Map<String, Any>? = try {
        val root = JSONObject(json)
        if (root.optString("format") != FORMAT) null
        else {
            val settings = root.getJSONObject("settings")
            val out = linkedMapOf<String, Any>()
            for (key in settings.keys()) {
                val entry = settings.getJSONObject(key)
                out[key] = when (entry.getString("type")) {
                    "boolean" -> entry.getBoolean("value")
                    "string" -> entry.getString("value")
                    "int" -> entry.getInt("value")
                    "long" -> entry.getLong("value")
                    "float" -> entry.getDouble("value").toFloat()
                    "stringSet" -> entry.getJSONArray("value").let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }
                    else -> continue
                }
            }
            out
        }
    } catch (e: Exception) {
        null
    }

    /**
     * Settings that belong to this phone, never to a file from another one: this phone's Play Integrity
     * device token (the server refuses another phone's), its agreement to the Accessibility disclosure
     * and to Yiddish training (Play wants each agreed on the phone itself), and its Yiddish install id,
     * which keeps two people's voices apart in training.
     */
    val THIS_PHONE = setOf("device_token", "acc_disclosure_agreed", YiddishServer.CONSENT, "yiddish_install")

    /** Replaces every current setting with [values], except [THIS_PHONE], which keep this phone's own. */
    fun apply(prefs: SharedPreferences, values: Map<String, Any>) {
        val own = prefs.all.filterKeys { it in THIS_PHONE }.filterValues { it != null }
        val edit = prefs.edit().clear()
        for ((key, value) in values.filterKeys { it !in THIS_PHONE } + own) {
            @Suppress("UNCHECKED_CAST")
            when (value) {
                is Boolean -> edit.putBoolean(key, value)
                is String -> edit.putString(key, value)
                is Int -> edit.putInt(key, value)
                is Long -> edit.putLong(key, value)
                is Float -> edit.putFloat(key, value)
                is Set<*> -> edit.putStringSet(key, value as Set<String>)
            }
        }
        edit.apply()
    }
}
