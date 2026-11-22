package com.kafkasl.phonewhisper

import android.content.Context

/** The GitHub builds never use the free-minutes server, so they never ask Google Play to vouch for them. */
object Integrity {
    fun token(context: Context, requestHash: String): String? = null
}
