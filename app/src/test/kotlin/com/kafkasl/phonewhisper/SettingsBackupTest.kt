package com.kafkasl.phonewhisper

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SettingsBackupTest {
    @Test fun everyTypeSurvivesExportAndImport() {
        val values = mapOf(
            "api_key" to "sk-or-v1-test",
            "verbatim" to true,
            "shortcut_hold_ms" to 500L,
            "acc_setup_phase" to 2,
            "some_float" to 1.5f,
            "known_placeholders" to setOf("a|Message", "b|Search"),
        )
        assertEquals(values, SettingsBackup.parse(SettingsBackup.export(values)))
    }

    @Test fun otherFilesAreRejected() {
        assertNull(SettingsBackup.parse("""{"settings":{}}"""))
        assertNull(SettingsBackup.parse("not json"))
    }

    @Test fun importKeepsWhatBelongsToThisPhone() {
        val prefs = MemoryPrefs(mutableMapOf(
            "api_key" to "old", "device_token" to "mine", "acc_disclosure_agreed" to true, "yiddish_install" to "my-install"))
        SettingsBackup.apply(prefs, mapOf(
            "api_key" to "new", "verbatim" to true, "device_token" to "other phone's", YiddishServer.CONSENT to true,
            "acc_disclosure_agreed" to true, "yiddish_install" to "other-install"))
        assertEquals(mapOf("api_key" to "new", "verbatim" to true, "device_token" to "mine",
            "acc_disclosure_agreed" to true, "yiddish_install" to "my-install"), prefs.all)
    }

    @Test fun importNeverBringsAnotherPhonesAgreementsOrToken() {
        val prefs = MemoryPrefs(mutableMapOf("api_key" to "old"))
        SettingsBackup.apply(prefs, mapOf("api_key" to "new", "device_token" to "other phone's",
            "acc_disclosure_agreed" to true, YiddishServer.CONSENT to true, "yiddish_install" to "other-install"))
        assertEquals(mapOf<String, Any?>("api_key" to "new"), prefs.all)
    }

    /** SharedPreferences in memory; commits on apply(). */
    private class MemoryPrefs(val values: MutableMap<String, Any?>) : SharedPreferences {
        override fun getAll(): MutableMap<String, *> = values.toMutableMap()
        override fun getString(key: String, defValue: String?) = values[key] as String? ?: defValue
        @Suppress("UNCHECKED_CAST")
        override fun getStringSet(key: String, defValues: MutableSet<String>?) = values[key] as MutableSet<String>? ?: defValues
        override fun getInt(key: String, defValue: Int) = values[key] as Int? ?: defValue
        override fun getLong(key: String, defValue: Long) = values[key] as Long? ?: defValue
        override fun getFloat(key: String, defValue: Float) = values[key] as Float? ?: defValue
        override fun getBoolean(key: String, defValue: Boolean) = values[key] as Boolean? ?: defValue
        override fun contains(key: String) = key in values
        override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener) {}
        override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener) {}
        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            val puts = mutableMapOf<String, Any?>()
            val removes = mutableSetOf<String>()
            var clear = false
            override fun putString(key: String, value: String?) = also { puts[key] = value }
            override fun putStringSet(key: String, value: MutableSet<String>?) = also { puts[key] = value }
            override fun putInt(key: String, value: Int) = also { puts[key] = value }
            override fun putLong(key: String, value: Long) = also { puts[key] = value }
            override fun putFloat(key: String, value: Float) = also { puts[key] = value }
            override fun putBoolean(key: String, value: Boolean) = also { puts[key] = value }
            override fun remove(key: String) = also { removes += key }
            override fun clear() = also { clear = true }
            override fun commit(): Boolean { apply(); return true }
            override fun apply() {
                if (clear) values.clear()
                removes.forEach { values.remove(it) }
                values.putAll(puts)
            }
        }
    }
}
