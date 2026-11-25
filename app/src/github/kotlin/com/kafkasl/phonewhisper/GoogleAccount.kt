package com.kafkasl.phonewhisper

import android.app.Activity
import android.content.Context

/** The GitHub builds take a typed access code instead of signing in with Google (Access.useCode). */
object GoogleAccount {
    const val available = false
    fun signIn(activity: Activity, callback: (idToken: String?, error: String?) -> Unit) = callback(null, null)
    fun signOut(context: Context) {}
}
