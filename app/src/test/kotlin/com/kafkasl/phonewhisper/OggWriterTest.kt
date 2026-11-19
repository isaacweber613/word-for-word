package com.kafkasl.phonewhisper

import org.junit.Assert.assertEquals
import org.junit.Test

class OggWriterTest {
    // TOC 0xF8: CELT, 20 ms, one frame = 960 samples at 48 kHz.
    private fun packet(size: Int) = ByteArray(size).also { it[0] = 0xF8.toByte() }

    private fun pages(ogg: ByteArray): List<Pair<Int, ByteArray>> {
        val out = mutableListOf<Pair<Int, ByteArray>>()
        var i = 0
        while (i < ogg.size) {
            val segs = ogg[i + 26].toInt() and 0xFF
            var len = 27 + segs
            for (s in 0 until segs) len += ogg[i + 27 + s].toInt() and 0xFF
            out.add(i to ogg.copyOfRange(i, i + len))
            i += len
        }
        return out
    }

    private fun granule(page: ByteArray): Long =
        (0 until 8).fold(0L) { acc, b -> acc or ((page[6 + b].toLong() and 0xFF) shl (8 * b)) }

    @Test fun `reads a packet's length from its first byte`() {
        assertEquals(960, OggWriter.samples48k(packet(10)))
        assertEquals(1920, OggWriter.samples48k(byteArrayOf(0xF9.toByte(), 0)))
    }

    @Test fun `writes head, tags and audio pages with valid checksums and positions`() {
        val ogg = OggWriter.write(List(120) { packet(80) }, preSkip = 312, inputRate = 16000)
        val p = pages(ogg)
        assertEquals(2 + 3, p.size) // head, tags, then 50 + 50 + 20 packets
        for ((_, page) in p) {
            val zeroed = page.copyOf().also { for (k in 22..25) it[k] = 0 }
            val crc = OggWriter.crc(zeroed)
            val stored = (0 until 4).fold(0) { acc, b -> acc or ((page[22 + b].toInt() and 0xFF) shl (8 * b)) }
            assertEquals(crc, stored)
        }
        assertEquals(312L + 120 * 960, granule(p.last().second))
        assertEquals(0x04, p.last().second[5].toInt()) // end of stream
        assertEquals(0x02, p.first().second[5].toInt()) // start of stream
    }
}
