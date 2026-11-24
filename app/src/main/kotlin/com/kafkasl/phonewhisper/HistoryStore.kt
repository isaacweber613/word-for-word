package com.kafkasl.phonewhisper

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Saved transcriptions, newest first, in a private file inside the app.
 * By default anything older than 24 hours is deleted; the "Keep history forever"
 * setting (pref "keep_history_forever") turns that off.
 *
 * An entry can also keep its recording ([Entry.audio], a file in `filesDir/audio`). A recording
 * that couldn't be typed (no key, no connection, server down) is always kept, with [Entry.error]
 * saying why, so the person still has what they said (Isaac, 2026-11-24). With "Always save
 * audio" (pref [ALWAYS_SAVE_AUDIO]) every typed recording keeps its audio too.
 */
object HistoryStore {
    /** [text] is empty and [error] says why when the recording couldn't be typed. */
    data class Entry(val time: Long, val text: String, val model: String, val audio: String? = null, val error: String? = null)

    const val ALWAYS_SAVE_AUDIO = "always_save_audio"
    private const val TAG = "PhoneWhisper"
    private const val FILE = "history.json"
    private const val DAY_MS = 24L * 60 * 60 * 1000
    private val lock = Any()

    private fun file(ctx: Context) = File(ctx.filesDir, FILE)
    fun audioDir(ctx: Context) = File(ctx.filesDir, "audio")
    fun audioFile(ctx: Context, entry: Entry) = entry.audio?.let { File(audioDir(ctx), it) }?.takeIf { it.exists() }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("phonewhisper", Context.MODE_PRIVATE)
    private fun keepForever(ctx: Context) = prefs(ctx).getBoolean("keep_history_forever", false)
    fun alwaysSaveAudio(ctx: Context) = prefs(ctx).getBoolean(ALWAYS_SAVE_AUDIO, false)

    private fun read(ctx: Context): MutableList<Entry> = try {
        val arr = JSONArray(file(ctx).takeIf { it.exists() }?.readText() ?: "[]")
        MutableList(arr.length()) { i ->
            val o = arr.getJSONObject(i)
            Entry(o.getLong("time"), o.getString("text"), o.optString("model"),
                o.optString("audio").ifEmpty { null }, o.optString("error").ifEmpty { null })
        }
    } catch (e: Exception) {
        mutableListOf()
    }

    private fun write(ctx: Context, entries: List<Entry>) {
        val arr = JSONArray()
        entries.forEach {
            arr.put(JSONObject().put("time", it.time).put("text", it.text).put("model", it.model)
                .apply { it.audio?.let { a -> put("audio", a) }; it.error?.let { e -> put("error", e) } })
        }
        val tmp = File(ctx.filesDir, "$FILE.tmp")
        tmp.writeText(arr.toString())
        tmp.renameTo(file(ctx))
    }

    /** Drops entries older than 24 hours, with their audio, unless the person chose to keep history forever. */
    private fun pruned(ctx: Context, entries: List<Entry>): List<Entry> {
        if (keepForever(ctx)) return entries
        val cutoff = System.currentTimeMillis() - DAY_MS
        val (kept, old) = entries.partition { it.time >= cutoff }
        old.forEach { deleteAudio(ctx, it) }
        return kept
    }

    private fun deleteAudio(ctx: Context, entry: Entry) { entry.audio?.let { File(audioDir(ctx), it).delete() } }

    /**
     * Saves [pcm] (16 kHz, 16-bit mono) as a small Ogg Opus file, or WAV on phones older than
     * Android 10. Returns the file name, or null if it couldn't be written. Takes a moment, so
     * call it off the main thread.
     */
    private fun saveAudio(ctx: Context, time: Long, pcm: ByteArray): String? = try {
        val wav = WavWriter.encode(pcm)
        val ogg = OggOpus.encode(wav)
        val name = "$time." + if (ogg != null) "ogg" else "wav"
        audioDir(ctx).mkdirs()
        File(audioDir(ctx), name).writeBytes(ogg ?: wav)
        name
    } catch (e: Exception) {
        Log.w(TAG, "Couldn't save the recording", e)
        null
    }

    /** Returns the new entry's time, which [update] uses to find it again. */
    fun add(ctx: Context, text: String, model: String): Long = synchronized(lock) {
        val time = System.currentTimeMillis()
        val entries = read(ctx)
        entries.add(0, Entry(time, text, model))
        write(ctx, pruned(ctx, entries))
        time
    }

    /**
     * A recording with its audio: [text] typed, or empty with [error] when it couldn't be typed.
     * [time] is the entry's time, chosen by the caller so [update] can find it. Call off the main thread,
     * and from the same thread as a later [update] of it.
     */
    fun addWithAudio(ctx: Context, time: Long, pcm: ByteArray, text: String, model: String, error: String? = null) {
        val audio = saveAudio(ctx, time, pcm)
        synchronized(lock) {
            val entries = read(ctx)
            entries.add(0, Entry(time, text, model, audio, error))
            write(ctx, pruned(ctx, entries))
        }
    }

    /** Changes the entry saved at [time], for example when a kept recording is typed on a later try. */
    fun update(ctx: Context, time: Long, change: (Entry) -> Entry) = synchronized(lock) {
        write(ctx, read(ctx).map { if (it.time == time) change(it) else it })
    }

    fun all(ctx: Context): List<Entry> = synchronized(lock) {
        val entries = read(ctx)
        val kept = pruned(ctx, entries)
        if (kept.size != entries.size) write(ctx, kept)
        kept
    }

    fun delete(ctx: Context, entry: Entry) = synchronized(lock) {
        deleteAudio(ctx, entry)
        write(ctx, read(ctx).filterNot { it.time == entry.time })
    }

    fun clear(ctx: Context) = synchronized(lock) { file(ctx).delete(); audioDir(ctx).deleteRecursively(); Unit }
}
