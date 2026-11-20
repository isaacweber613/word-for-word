package com.kafkasl.phonewhisper

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Base64
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.LockSupport
import kotlin.concurrent.thread

/**
 * How long the text waits on the phone after the person stops recording (Isaac, 2026-11-20:
 * "can you make a test, some better if it's like automatic test that would block any regressions
 * in this speed?"). 0.9.7 and 0.9.8 compressed the whole recording after the stop, about 7 s
 * after 12.5 s of speech on his Pixel; 0.9.9 compresses while recording and takes 14 to 24 ms.
 * Isaac: under 50 ms after the stop is fine.
 *
 * A 15 s speech clip (Windows text to speech, assets/speech15s.pcm, 16 kHz 16-bit mono) is fed in
 * the microphone's own piece size at real-time pace, the way WhisperAccessibilityService records.
 */
@RunWith(AndroidJUnit4::class)
class AfterStopSpeedTest {
    companion object {
        private const val TAG = "AfterStopSpeed"
        private const val LIMIT_MS = 50.0
        private const val SECONDS = 15

        private val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
        private lateinit var clip: ByteArray
        private lateinit var server: FakeServer
        private var coldMs = 0.0

        /**
         * Runs one dictation first, so starting the codec, OkHttp and the JSON code for the first
         * time in this process isn't counted. Reports those cold times.
         */
        @BeforeClass @JvmStatic fun warmUp() {
            clip = InstrumentationRegistry.getInstrumentation().context.assets.open("speech15s.pcm").use { it.readBytes() }
            assertEquals(SECONDS * 32000, clip.size)
            server = FakeServer()
            TranscriberClient.serverUrl = server.url
            TranscriberClient.openRouterUrl = server.url
            // The Play build with no key uses the free-minutes server; the GitHub builds need a key.
            context.getSharedPreferences("phonewhisper", Context.MODE_PRIVATE).edit().apply {
                remove("cloud_model"); remove("language"); remove("verbatim")
                if (FreeMinutes.available) remove("api_key") else putString("api_key", "test-key")
            }.commit()

            val stream = OggOpus.Stream.start()!!
            CloudTranscription.warm(context)
            val pcm = record(stream)
            coldMs = ms { stream.finish() }
            // finish() again returns the same file at once, so this times only the rest of the path.
            val restMs = dictate(stream, pcm)
            report("Cold (first time in this process): compression %.1f ms, then %.1f ms more to upload start".format(coldMs, restMs))
        }

        @AfterClass @JvmStatic fun stopServer() {
            server.close()
            TranscriberClient.serverUrl = BuildConfig.SERVICE_URL + "/v1/transcriptions"
            TranscriberClient.openRouterUrl = "https://openrouter.ai/api/v1/audio/transcriptions"
        }

        /**
         * The stop, as stopAndTranscribe and transcribeApi run it: WavWriter, then
         * CloudTranscription.run with the stream. Returns ms from the stop to the upload's first
         * byte reaching [server], and checks the upload and the answer.
         */
        fun dictate(stream: OggOpus.Stream, pcm: ByteArray): Double {
            val done = CountDownLatch(1)
            var outcome: CloudTranscription.Outcome? = null
            val stoppedAt = System.nanoTime()
            CloudTranscription.run(context, WavWriter.encode(pcm), stream) { outcome = it; done.countDown() }
            assertTrue("no answer", done.await(30, TimeUnit.SECONDS))
            assertEquals("Hi Sarah.", outcome?.text)
            val audio = JSONObject(server.postBody!!).getJSONObject("input_audio")
            assertEquals("the upload is the compressed recording", "ogg", audio.getString("format"))
            assertValidOggOpus(Base64.decode(audio.getString("data"), Base64.DEFAULT))
            report("Body fully received %.1f ms after the stop".format((server.postReceived - stoppedAt) / 1e6))
            return (server.postStarted - stoppedAt) / 1e6
        }

        /**
         * Plays the clip into [stream] as the microphone would: pieces of AudioRecord's minimum
         * buffer, each handed over when it would have finished recording. Returns the PCM.
         */
        fun record(stream: OggOpus.Stream): ByteArray {
            val piece = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val start = System.nanoTime()
            var at = 0
            while (at < clip.size) {
                val n = minOf(piece, clip.size - at)
                val due = start + (at + n) * 1_000_000_000L / 32000
                while (System.nanoTime() < due) LockSupport.parkNanos(due - System.nanoTime())
                stream.write(clip.copyOfRange(at, at + n), n)
                at += n
            }
            return clip
        }

        inline fun ms(block: () -> Unit): Double {
            val t = System.nanoTime(); block(); return (System.nanoTime() - t) / 1e6
        }

        /** Shows in the Gradle test output (instrumentation status) and in logcat. */
        fun report(line: String) {
            Log.i(TAG, line)
            InstrumentationRegistry.getInstrumentation().sendStatus(0, android.os.Bundle().apply { putString("stream", "$line\n") })
        }

        /** Checks the Ogg pages (RFC 7845) and that Android's own reader opens it as 15 s of Opus. */
        fun assertValidOggOpus(ogg: ByteArray) {
            var i = 0
            var pages = 0
            var lastFlags = 0
            var granule = 0L
            while (i < ogg.size) {
                assertEquals("OggS", String(ogg, i, 4))
                val segs = ogg[i + 26].toInt() and 0xFF
                var len = 27 + segs
                for (s in 0 until segs) len += ogg[i + 27 + s].toInt() and 0xFF
                val page = ogg.copyOfRange(i, i + len)
                val stored = (0 until 4).fold(0) { acc, b -> acc or ((page[22 + b].toInt() and 0xFF) shl (8 * b)) }
                assertEquals("checksum of page $pages", OggWriter.crc(page.copyOf().also { for (k in 22..25) it[k] = 0 }), stored)
                if (pages == 0) assertEquals("OpusHead", String(page, 27 + segs, 8))
                if (pages == 1) assertEquals("OpusTags", String(page, 27 + segs, 8))
                granule = (0 until 8).fold(0L) { acc, b -> acc or ((page[6 + b].toLong() and 0xFF) shl (8 * b)) }
                lastFlags = page[5].toInt()
                pages++
                i += len
            }
            assertEquals("last page ends the stream", 0x04, lastFlags)
            assertTrue("audio pages after head and tags", pages > 2)
            // 15 s at 48 kHz, plus the encoder delay (pre-skip) and up to one 20 ms packet.
            assertTrue("granule $granule", granule in SECONDS * 48000L..SECONDS * 48000L + 960 + 48000 / 10)

            val file = File(context.cacheDir, "speed-test.ogg").apply { writeBytes(ogg) }
            val extractor = MediaExtractor()
            try {
                extractor.setDataSource(file.path)
                assertEquals(1, extractor.trackCount)
                val format = extractor.getTrackFormat(0)
                assertEquals(MediaFormat.MIMETYPE_AUDIO_OPUS, format.getString(MediaFormat.KEY_MIME))
                val us = format.getLong(MediaFormat.KEY_DURATION)
                assertTrue("duration $us us", us in (SECONDS * 1_000_000L - 100_000)..(SECONDS * 1_000_000L + 100_000))
            } finally {
                extractor.release(); file.delete()
            }
        }
    }

    /** OggOpus.Stream, exactly as the recorder uses it: only finish() runs after the stop. */
    @Test fun compressingAfterTheStopTakesUnder50ms() {
        val stream = OggOpus.Stream.start()!!
        val pcm = record(stream)
        var ogg: ByteArray? = null
        val warmMs = ms { ogg = stream.finish() }
        report("Warm after-stop compression: %.1f ms (cold %.1f ms), %d bytes Ogg from %d bytes WAV"
            .format(warmMs, coldMs, ogg?.size ?: 0, pcm.size + 44))

        assertNotNull("compressing failed", ogg)
        assertValidOggOpus(ogg!!)
        // 24 kbit/s Opus is about a tenth of 256 kbit/s WAV; a fifth leaves room and still catches no compression.
        assertTrue("Ogg ${ogg!!.size} bytes isn't much smaller than WAV ${pcm.size + 44}", ogg!!.size < (pcm.size + 44) / 5)
        assertTrue("after-stop compression took %.1f ms, limit %.0f ms".format(warmMs, LIMIT_MS), warmMs < LIMIT_MS)
    }

    /**
     * The dictation path after the stop, as WhisperAccessibilityService.transcribeApi runs it:
     * WavWriter, CloudTranscription.run with the stream, the request body, and OkHttp starting the
     * upload to a server on the phone ([FakeServer]). Timed to the request's first byte reaching
     * the server: everything before it is the phone's work; the body's trip after it is the
     * network's. Catches any change that compresses the whole recording after the stop again,
     * such as CloudTranscription ignoring the stream.
     */
    @Test fun stopToUploadStartTakesUnder50ms() {
        // Recording starts: compress while recording and open the connection (startRecording).
        val stream = OggOpus.Stream.start()!!
        CloudTranscription.warm(context)
        val pcm = record(stream)
        val stopToSentMs = dictate(stream, pcm)
        report("Warm stop to upload started: %.1f ms".format(stopToSentMs))
        assertTrue("stop to upload started took %.1f ms, limit %.0f ms".format(stopToSentMs, LIMIT_MS), stopToSentMs < LIMIT_MS)
    }

    /**
     * A tiny HTTP server on the phone that notes when a POST's first byte arrives. Answers HEAD
     * (CloudTranscription.warm) with 404 and a POST with a transcript, on a kept-alive connection.
     */
    private class FakeServer : AutoCloseable {
        private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val url = "http://127.0.0.1:${socket.localPort}/v1/transcriptions"
        @Volatile var postStarted = 0L
        @Volatile var postReceived = 0L
        @Volatile var postBody: String? = null

        init {
            thread(isDaemon = true) {
                while (!socket.isClosed) {
                    val client = try { socket.accept() } catch (_: Exception) { break }
                    thread(isDaemon = true) { client.use { serve(it) } }
                }
            }
        }

        private fun serve(client: Socket) {
            val input = client.getInputStream().buffered()
            val output = client.getOutputStream()
            while (true) {
                val first = input.read()
                if (first < 0) return
                val arrived = System.nanoTime()
                val head = StringBuilder().append(first.toChar())
                while (!head.endsWith("\r\n\r\n")) {
                    val c = input.read(); if (c < 0) return; head.append(c.toChar())
                }
                val length = Regex("(?i)content-length: *(\\d+)").find(head)?.groupValues?.get(1)?.toInt() ?: 0
                val body = ByteArray(length)
                var got = 0
                while (got < length) { val n = input.read(body, got, length - got); if (n < 0) return; got += n }
                val reply = if (head.startsWith("POST")) {
                    postStarted = arrived; postReceived = System.nanoTime(); postBody = String(body)
                    val json = """{"text":"Hi Sarah."}"""
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${json.length}\r\n\r\n$json"
                } else "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"
                output.write(reply.toByteArray()); output.flush()
            }
        }

        override fun close() = socket.close()
    }
}

