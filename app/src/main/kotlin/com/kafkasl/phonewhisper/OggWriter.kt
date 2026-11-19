package com.kafkasl.phonewhisper

import java.io.ByteArrayOutputStream

/**
 * Wraps Opus packets in an Ogg file (RFC 7845). Android's own Ogg muxer writes files that
 * Microsoft's MAI-Transcribe 2 rejects as "malformed" (tested 2026-11-19; the same audio
 * re-wrapped by ffmpeg was accepted), so the app writes the pages itself.
 */
object OggWriter {
    private const val SERIAL = 0x57464f57 // "WFOW"
    private const val PACKETS_PER_PAGE = 50 // about a second of 20 ms packets

    /** [packets] are raw Opus packets; [preSkip] is in 48 kHz samples; [inputRate] is informational. */
    fun write(packets: List<ByteArray>, preSkip: Int, inputRate: Int, channels: Int = 1): ByteArray {
        val out = ByteArrayOutputStream()
        var seq = 0
        val head = ByteArrayOutputStream().apply {
            write("OpusHead".toByteArray())
            write(1); write(channels)
            le16(this, preSkip); le32(this, inputRate); le16(this, 0); write(0)
        }.toByteArray()
        page(out, listOf(head), 0L, seq++, 0x02)
        val vendor = "Word for Word".toByteArray()
        val tags = ByteArrayOutputStream().apply {
            write("OpusTags".toByteArray()); le32(this, vendor.size); write(vendor); le32(this, 0)
        }.toByteArray()
        page(out, listOf(tags), 0L, seq++, 0)

        var granule = preSkip.toLong()
        // Up to a second of packets per page, and never more than a page's 255 segments.
        val chunks = mutableListOf<MutableList<ByteArray>>()
        var segs = 0
        for (p in packets) {
            val need = p.size / 255 + 1
            if (chunks.isEmpty() || chunks.last().size >= PACKETS_PER_PAGE || segs + need > 255) {
                chunks.add(mutableListOf()); segs = 0
            }
            chunks.last().add(p); segs += need
        }
        if (chunks.isEmpty()) page(out, emptyList(), granule, seq, 0x04)
        chunks.forEachIndexed { i, chunk ->
            chunk.forEach { granule += samples48k(it) }
            page(out, chunk, granule, seq++, if (i == chunks.lastIndex) 0x04 else 0)
        }
        return out.toByteArray()
    }

    /** Length of one Opus packet in 48 kHz samples, from its first byte (RFC 6716, 3.1). */
    fun samples48k(packet: ByteArray): Int {
        if (packet.isEmpty()) return 0
        val toc = packet[0].toInt() and 0xFF
        val config = toc shr 3
        val frame = when {
            config < 12 -> intArrayOf(480, 960, 1920, 2880)[config and 3]
            config < 16 -> intArrayOf(480, 960)[config and 1]
            else -> intArrayOf(120, 240, 480, 960)[config and 3]
        }
        val frames = when (toc and 3) {
            0 -> 1
            1, 2 -> 2
            else -> if (packet.size > 1) packet[1].toInt() and 0x3F else 1
        }
        return frame * frames
    }

    private fun page(out: ByteArrayOutputStream, packets: List<ByteArray>, granule: Long, seq: Int, flags: Int) {
        val lacing = ByteArrayOutputStream()
        packets.forEach { p ->
            var n = p.size
            while (n >= 255) { lacing.write(255); n -= 255 }
            lacing.write(n)
        }
        val segs = lacing.toByteArray()
        require(segs.size <= 255) { "Too many segments for one Ogg page" }
        val page = ByteArrayOutputStream().apply {
            write("OggS".toByteArray()); write(0); write(flags)
            le64(this, granule); le32(this, SERIAL); le32(this, seq); le32(this, 0)
            write(segs.size); write(segs)
            packets.forEach { write(it) }
        }.toByteArray()
        val crc = crc(page)
        page[22] = crc.toByte(); page[23] = (crc shr 8).toByte()
        page[24] = (crc shr 16).toByte(); page[25] = (crc shr 24).toByte()
        out.write(page)
    }

    private val TABLE = IntArray(256) { i ->
        var r = i shl 24
        repeat(8) { r = if (r and 0x80000000.toInt() != 0) (r shl 1) xor 0x04c11db7 else r shl 1 }
        r
    }

    /** Ogg's CRC-32: polynomial 0x04c11db7, no reflection, starts at 0. */
    internal fun crc(data: ByteArray): Int {
        var c = 0
        for (b in data) c = (c shl 8) xor TABLE[((c ushr 24) xor (b.toInt() and 0xFF)) and 0xFF]
        return c
    }

    private fun le16(o: ByteArrayOutputStream, v: Int) { o.write(v and 0xFF); o.write((v shr 8) and 0xFF) }
    private fun le32(o: ByteArrayOutputStream, v: Int) { for (i in 0 until 4) o.write((v shr (8 * i)) and 0xFF) }
    private fun le64(o: ByteArrayOutputStream, v: Long) { for (i in 0 until 8) o.write(((v shr (8 * i)) and 0xFF).toInt()) }
}
