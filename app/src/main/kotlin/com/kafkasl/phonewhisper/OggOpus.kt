package com.kafkasl.phonewhisper

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.util.Log
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import kotlin.concurrent.thread

/**
 * Shrinks a recording before it's uploaded (Isaac, 2026-11-19: "It should be as fast as
 * possible"). A 14-second WAV is 440 KB; as Ogg Opus it's about 38 KB, so it reaches the server
 * quickly even on a weak phone signal. Tested that day: MAI-Transcribe 2, GPT Transcribe,
 * Voxtral Mini Transcribe 3 and Scribe v2 on OpenRouter all accept "ogg". Android's encoder makes
 * the Opus audio and [OggWriter] wraps it, so the app doesn't grow. Needs Android 10; older
 * phones send WAV.
 *
 * Dictation compresses while you speak ([Stream]): compressing a 13.7 s recording after the stop
 * took 1.4 s on the emulator and about 7 s on Isaac's Pixel in 0.9.7 and 0.9.8, so now only the
 * last fraction of a second is left when you stop. Shared files and retries use [encode].
 */
object OggOpus {
    private const val TAG = "PhoneWhisper"
    private const val RATE = 16000
    private const val BIT_RATE = 24000

    /** [wav] is 16 kHz, 16-bit mono with a 44-byte header, as WavWriter makes it. Null on failure. */
    fun encode(wav: ByteArray): ByteArray? {
        if (Build.VERSION.SDK_INT < 29 || wav.size <= 44) return null
        var encoder: Encoder? = null
        return try {
            encoder = Encoder()
            encoder.feed(wav, 44, wav.size - 44)
            encoder.finish()
        } catch (e: Exception) {
            Log.w(TAG, "Couldn't compress the recording; sending WAV", e)
            null
        } finally {
            encoder?.release()
        }
    }

    /**
     * Compresses 16 kHz, 16-bit mono audio as it is recorded, on its own thread. Call [write] with
     * each piece from the microphone, then [finish] once, or [cancel] to throw it away.
     */
    class Stream private constructor() {
        private val queue = LinkedBlockingQueue<ByteArray>()
        private val end = ByteArray(0)
        @Volatile private var result: ByteArray? = null
        private val worker = thread(name = "opus-stream") {
            var encoder: Encoder? = null
            try {
                encoder = Encoder()
                while (true) {
                    val piece = queue.take()
                    if (piece === end) break
                    encoder.feed(piece, 0, piece.size)
                }
                result = encoder.finish()
            } catch (e: Exception) {
                Log.w(TAG, "Couldn't compress while recording; compressing after", e)
            } finally {
                encoder?.release()
            }
        }

        fun write(pcm: ByteArray, n: Int) { queue.put(pcm.copyOf(n)) }

        /** Waits for the last pieces and returns the Ogg file, or null if compressing failed. */
        fun finish(): ByteArray? { queue.put(end); worker.join(); return result }

        fun cancel() { queue.clear(); queue.put(end) }

        companion object {
            /** Null on phones older than Android 10, which send WAV. */
            fun start(): Stream? = if (Build.VERSION.SDK_INT >= 29) Stream() else null
        }
    }

    /** Feeds audio to Android's Opus encoder and collects the packets for [OggWriter]. */
    private class Encoder {
        private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
        private val info = MediaCodec.BufferInfo()
        private val packets = ArrayList<ByteArray>()
        private var preSkip = 312 // libopus's usual delay at 48 kHz, if the encoder doesn't say
        private var samples = 0L

        init {
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, RATE, 1)
                .apply { setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE) }
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
        }

        fun feed(pcm: ByteArray, from: Int, length: Int) {
            var offset = from
            val end = from + length
            while (offset < end) {
                val i = codec.dequeueInputBuffer(10_000)
                if (i >= 0) {
                    val buf = codec.getInputBuffer(i)!!
                    buf.clear()
                    val n = minOf(buf.remaining(), end - offset) and 1.inv()
                    if (n <= 0) { codec.queueInputBuffer(i, 0, 0, pts(), 0); break }
                    buf.put(pcm, offset, n)
                    codec.queueInputBuffer(i, 0, n, pts(), 0)
                    offset += n
                    samples += n / 2
                }
                drain(wait = false)
            }
        }

        fun finish(): ByteArray? {
            while (true) {
                val i = codec.dequeueInputBuffer(10_000)
                if (i >= 0) { codec.queueInputBuffer(i, 0, 0, pts(), MediaCodec.BUFFER_FLAG_END_OF_STREAM); break }
                drain(wait = false)
            }
            while (!drain(wait = true)) { /* the last packets */ }
            val ogg = OggWriter.write(packets, preSkip, RATE)
            // Something went wrong if it isn't much smaller than the WAV (2 bytes a sample); send the WAV then.
            return ogg.takeIf { packets.isNotEmpty() && it.size < samples }
        }

        fun release() {
            try { codec.stop() } catch (_: Exception) {}
            try { codec.release() } catch (_: Exception) {}
        }

        private fun pts() = samples * 1_000_000L / RATE

        /**
         * Takes every packet that's ready. Waits only when [wait] (all audio is in): 0.9.7 and 0.9.8
         * waited 10 ms after every slice, which added 0.57 s per second of audio. True at the end.
         */
        private fun drain(wait: Boolean): Boolean {
            while (true) {
                val o = codec.dequeueOutputBuffer(info, if (wait) 10_000 else 0)
                if (o == MediaCodec.INFO_TRY_AGAIN_LATER) return false
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    // csd-1 is the encoder's delay in nanoseconds (Android's Opus codec-specific data).
                    codec.outputFormat.getByteBuffer("csd-1")?.let { b ->
                        if (b.remaining() >= 8) {
                            val ns = b.duplicate().order(ByteOrder.LITTLE_ENDIAN).long
                            if (ns in 1..1_000_000_000L) preSkip = (ns * 48_000 / 1_000_000_000L).toInt()
                        }
                    }
                } else if (o >= 0) {
                    val out = codec.getOutputBuffer(o)!!
                    val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                    if (!config && info.size > 0) {
                        val p = ByteArray(info.size)
                        out.position(info.offset)
                        out.get(p)
                        packets.add(p)
                    }
                    codec.releaseOutputBuffer(o, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return true
                }
            }
        }
    }
}
