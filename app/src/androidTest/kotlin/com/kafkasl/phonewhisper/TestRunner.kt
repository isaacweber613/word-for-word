package com.kafkasl.phonewhisper

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner

/** Turns usage stats off before the app starts, so test runs never reach PostHog as events. */
class TestRunner : AndroidJUnitRunner() {
    override fun callApplicationOnCreate(app: Application) {
        app.getSharedPreferences("phonewhisper", Context.MODE_PRIVATE).edit().putBoolean("analytics", false).commit()
        super.callApplicationOnCreate(app)
    }
}
