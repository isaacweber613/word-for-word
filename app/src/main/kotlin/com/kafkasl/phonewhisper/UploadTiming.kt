package com.kafkasl.phonewhisper

import okhttp3.Call
import okhttp3.EventListener
import okhttp3.Protocol
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy

/**
 * Times each step of one upload, so a slow transcription shows where the time went
 * (Isaac, 2026-11-19, after some recordings took 26 s to reach the server while the server
 * answered in 0.5 s). Sent as the "upload_timing" usage event: only durations, sizes and
 * whether the connection was reused. Never the audio, the words or the key.
 */
class UploadTiming(private val via: String, private val model: String, private val format: String) : EventListener() {
    private fun now() = System.nanoTime()
    private val start = now()
    private var dnsStart = 0L; private var dnsMs = -1L
    private var connectStart = 0L; private var connectMs = -1L
    private var connects = 0; private var connectFailures = 0
    private var sendStart = 0L; private var sendEnd = 0L
    private var bytes = 0L
    private var firstByte = 0L
    private var reused = true
    private var sends = 0
    private fun ms(from: Long, to: Long = now()) = if (from == 0L) -1L else (to - from) / 1_000_000

    override fun dnsStart(call: Call, domainName: String) { dnsStart = now() }
    override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) { dnsMs = ms(dnsStart) }
    override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
        reused = false; connects++; if (connectStart == 0L) connectStart = now()
    }
    override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) { connectMs = ms(connectStart) }
    override fun connectFailed(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?, ioe: IOException) { connectFailures++ }
    override fun requestHeadersStart(call: Call) { sends++; if (sendStart == 0L) sendStart = now() }
    override fun requestBodyEnd(call: Call, byteCount: Long) { sendEnd = now(); bytes = byteCount }
    override fun responseHeadersStart(call: Call) { if (firstByte == 0L) firstByte = now() }

    override fun callEnd(call: Call) = report(null)
    override fun callFailed(call: Call, ioe: IOException) = report(ioe)

    private fun report(error: IOException?) {
        Analytics.track("upload_timing", mapOf(
            "via" to via, "model" to model, "format" to format,
            "total_ms" to ms(start),
            "dns_ms" to dnsMs,
            "connect_ms" to connectMs,
            "reused_connection" to reused,
            "connect_attempts" to connects, "connect_failures" to connectFailures,
            // More than 1 means OkHttp sent the request again, e.g. after a dead connection.
            "send_attempts" to sends,
            // From the first byte sent to the last byte of the recording sent.
            "send_ms" to if (sendEnd != 0L) ms(sendStart, sendEnd) else -1L,
            // From the recording fully sent to the answer starting to arrive.
            "wait_ms" to if (sendEnd != 0L && firstByte != 0L) ms(sendEnd, firstByte) else -1L,
            // From the start of the call to the first byte sent: connecting, or waiting on a stale connection.
            "before_send_ms" to ms(start, if (sendStart != 0L) sendStart else now()),
            "bytes" to bytes,
            "error" to (error?.javaClass?.simpleName ?: "")))
    }
}
