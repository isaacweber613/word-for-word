package com.kafkasl.phonewhisper

import android.content.Context
import android.util.Log
import com.google.android.gms.tasks.Tasks
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityException
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Google Play Integrity (Isaac, 2026-11-22): Play vouches that this is its own build of Word for
 * Word on a real phone, so the free-minutes server serves only the Play app (FreeMinutes.register).
 */
object Integrity {
    private const val TAG = "PhoneWhisper"
    /** The Google Cloud project "Word for Word" (word-for-word-515315), linked in Play Console. */
    private const val CLOUD_PROJECT = 384040985984L
    /** Google's docs suggest allowing about a minute, since preparing calls Google's servers. */
    private const val WAIT_MINUTES = 1L

    /**
     * Why the last [token] call got none: Google's error code (StandardIntegrityErrorCode, such as "-12"),
     * "timeout", or "error:" and the exception's name. For the Failed checks list (FreeMinutes.register).
     */
    @Volatile var lastError: String? = null
        private set

    /** A Play Integrity token whose request hash is [requestHash], or null. Blocks; not on the main thread. */
    fun token(context: Context, requestHash: String): String? = try {
        val manager = IntegrityManagerFactory.createStandard(context.applicationContext)
        val provider = Tasks.await(manager.prepareIntegrityToken(
            PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(CLOUD_PROJECT).build()), WAIT_MINUTES, TimeUnit.MINUTES)
        Tasks.await(provider.request(StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build()),
            WAIT_MINUTES, TimeUnit.MINUTES).token()
    } catch (e: Exception) {
        Log.w(TAG, "Play Integrity gave no token", e)
        lastError = when (val cause = (e as? ExecutionException)?.cause ?: e) {
            is StandardIntegrityException -> cause.errorCode.toString()
            is TimeoutException -> "timeout"
            else -> "error:" + cause.javaClass.simpleName
        }
        null
    }
}
