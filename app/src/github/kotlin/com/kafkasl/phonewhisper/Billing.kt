package com.kafkasl.phonewhisper

import android.app.Activity
import android.content.Context

/** The GitHub builds sell nothing: they always use the person's own OpenRouter key (see the play build's Billing). */
object Billing {
    const val available = false
    const val CANCELED = "canceled"
    fun subscribe(activity: Activity, done: (String?) -> Unit) = done("Subscriptions are only in the Play Store version.")
    fun buyHours(activity: Activity, done: (String?) -> Unit) = done("Subscriptions are only in the Play Store version.")
    fun manage(activity: Activity) {}
    /** Nothing to send; asks the server what is left of the hours given with an access code. True when time is left. */
    fun sync(context: Context, done: (Boolean) -> Unit) {
        kotlin.concurrent.thread {
            FreeMinutes.usageNow(context)
            done(!FreeMinutes.out(context))
        }
    }
}
