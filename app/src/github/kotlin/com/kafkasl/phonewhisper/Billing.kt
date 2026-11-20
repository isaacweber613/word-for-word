package com.kafkasl.phonewhisper

import android.app.Activity
import android.content.Context

/** The GitHub builds sell nothing: they always use the person's own OpenRouter key (see the play build's Billing). */
object Billing {
    const val available = false
    fun subscribe(activity: Activity, done: (String?) -> Unit) = done("Subscriptions are only in the Play Store version.")
    fun buyHours(activity: Activity, done: (String?) -> Unit) = done("Subscriptions are only in the Play Store version.")
    fun manage(activity: Activity) {}
    fun sync(context: Context, done: (Boolean) -> Unit) = done(false)
}
