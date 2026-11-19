package com.kafkasl.phonewhisper

import android.content.Context
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.util.Log
import java.nio.ByteOrder

/**
 * Shrinks a recording before it's uploaded (Isaac, 2026-11-19: "It should be as fast as
 * possible"). A 14-second WAV is 440 KB; as Ogg Opus it's about 55 KB, so it reaches the server
 * quickly even on a weak phone signal. Tested that day: MAI-Transcribe 2, GPT Transcribe,
 * Voxtral Mini Transcribe 3 and Scribe v2 on OpenRouter all accept "ogg". Android's encoder makes
 * the Opus audio and [OggWriter] wraps it, so the app doesn't grow. Needs Android 10; older
 * phones send WAV.
 */
object OggOpus {
    private const val TAG = "PhoneWhisper"
    private const val RATE = 16000
    private const val BIT_RATE = 24000

    /** [wav] is 16 kHz, 16-bit mono with a 44-byte header, as WavWriter makes it. Null on failure. */
    fun encode(context: Context, wav: ByteArray): ByteArray? {
        if (Build.VERSION.SDK_INT < 29 || wav.size <= 44) return null
        var codec: MediaCodec? = null
        try {
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, RATE, 1)
                .apply { setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE) }
            codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            val info = MediaCodec.BufferInfo()
            val packets = ArrayList<ByteArray>()
            var preSkip = 312 // libopus's usual delay at 48 kHz, if the encoder doesn't say
            var offset = 44
            var inputDone = false
            var ptsUs = 0L
            while (true) {
                if (!inputDone) {
                    val i = codec.dequeueInputBuffer(10_000)
                    if (i >= 0) {
                        val buf = codec.getInputBuffer(i)!!
                        buf.clear()
                        val n = minOf(buf.remaining(), wav.size - offset) and 1.inv()
                        if (n <= 0) {
                            codec.queueInputBuffer(i, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            buf.put(wav, offset, n)
                            codec.queueInputBuffer(i, 0, n, ptsUs, 0)
                            offset += n
                            ptsUs += n / 2 * 1_000_000L / RATE
                        }
                    }
                }
                val o = codec.dequeueOutputBuffer(info, 10_000)
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
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                }
            }
            val ogg = OggWriter.write(packets, preSkip, RATE)
            // Something went wrong if it isn't much smaller; send the WAV then.
            return ogg.takeIf { packets.isNotEmpty() && it.size < wav.size / 2 }
        } catch (e: Exception) {
            Log.w(TAG, "Couldn't compress the recording; sending WAV", e)
            return null
        } finally {
            try { codec?.stop() } catch (_: Exception) {}
            try { codec?.release() } catch (_: Exception) {}
        }
    }
}
