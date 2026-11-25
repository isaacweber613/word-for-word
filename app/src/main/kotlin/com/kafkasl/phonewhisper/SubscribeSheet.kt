package com.kafkasl.phonewhisper

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Isaac (2026-11-25), about the message the mic showed when the free minutes were used up: "It
 * doesn't push me hard enough and make it easy enough to subscribe. That pop-up should probably be
 * a subscribe button." So when nothing is left ([FreeMinutes.OUT_FREE], [FreeMinutes.OUT_HOURS]) a
 * small sheet opens over the app you're in, with one button that opens Google Play's purchase
 * screen right there. Play build only ([Billing.available]); the GitHub builds keep the plain
 * message, and hours given on the Access page ([FreeMinutes.OUT_GIVEN]) can't be bought, so they
 * keep theirs too.
 */
object SubscribeSheet {
    /** True when [message] means a purchase would let the next recording through. */
    fun offers(message: String?) = Billing.available &&
        (message == FreeMinutes.OUT_FREE || message == FreeMinutes.OUT_HOURS)

    /**
     * From the accessibility service, which has no screen of its own to host Google Play's
     * purchase screen: opens [SubscribeActivity] over the current app. False when there's nothing
     * to sell, so the caller shows [message] as before. Android lets the service open it only while
     * one of its windows (the floating button) is on screen; when the sheet hasn't opened shortly
     * after, [notShown] runs so the caller can show [message] instead.
     */
    fun offer(context: Context, message: String, notShown: () -> Unit): Boolean {
        if (!offers(message)) return false
        val asked = SystemClock.uptimeMillis()
        context.startActivity(Intent(context, SubscribeActivity::class.java)
            .putExtra(SubscribeActivity.HOURS, message == FreeMinutes.OUT_HOURS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        Handler(Looper.getMainLooper()).postDelayed({ if (SubscribeActivity.shownAt < asked) notShown() }, 1500)
        return true
    }

    /**
     * Shows the sheet on [activity]. [hours] sells 4 more hours instead of the subscription.
     * After a purchase it shows [readyText] for a moment, or closes at once when that's null.
     * [closed] gets true when something was bought.
     */
    fun show(activity: Activity, hours: Boolean, readyText: String?, closed: (Boolean) -> Unit): Dialog {
        val density = activity.resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()
        fun attr(id: Int): Int {
            val a = activity.obtainStyledAttributes(intArrayOf(id))
            return try { a.getColor(0, Color.GRAY) } finally { a.recycle() }
        }

        val buyLabel = if (hours) "Add 4 hours for \$1" else "Subscribe, 10 hours a month for \$3"
        var bought = false
        val dialog = Dialog(activity)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)

        val message = TextView(activity).apply {
            text = if (hours) "You've used this month's hours." else "You've used this month's free minutes."
            textSize = 16f
            setTextColor(attr(android.R.attr.textColorPrimary))
        }
        val buy = Button(activity).apply {
            text = buyLabel
            isAllCaps = false
            textSize = 16f
            setTextColor(Color.WHITE)
            stateListAnimator = null
            minHeight = dp(48)
            background = GradientDrawable().apply {
                cornerRadius = dp(8).toFloat()
                setColor(activity.getColor(R.color.primary))
            }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = dp(16) }
        }
        val notNow = TextView(activity).apply {
            text = "Not now"
            textSize = 14f
            gravity = Gravity.CENTER
            setTextColor(attr(android.R.attr.textColorSecondary))
            setPadding(dp(16), dp(12), dp(16), dp(4))
            setOnClickListener { dialog.dismiss() }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                .apply { gravity = Gravity.CENTER_HORIZONTAL }
        }

        fun ready() {
            bought = true
            if (readyText == null) { dialog.dismiss(); return }
            message.text = readyText
            buy.visibility = View.GONE
            notNow.text = "Close"
            message.postDelayed({ dialog.dismiss() }, 3000)
        }
        buy.setOnClickListener {
            buy.isEnabled = false
            buy.text = "Opening Google Play..."
            val done: (String?) -> Unit = { result ->
                activity.runOnUiThread {
                    if (!dialog.isShowing) return@runOnUiThread
                    when (result) {
                        null -> ready()
                        else -> {
                            if (result != Billing.CANCELED) message.text = result
                            buy.isEnabled = true
                            buy.text = buyLabel
                        }
                    }
                }
            }
            if (hours) Billing.buyHours(activity, done) else Billing.subscribe(activity, done)
        }

        dialog.setContentView(LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(20), dp(24), dp(12))
            background = GradientDrawable().apply {
                val r = dp(16).toFloat()
                cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
                setColor(attr(android.R.attr.colorBackground))
            }
            addView(message)
            addView(buy)
            addView(notNow)
        })
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setGravity(Gravity.BOTTOM)
        }
        dialog.setCanceledOnTouchOutside(true)
        dialog.setOnDismissListener { closed(bought) }
        dialog.show()
        return dialog
    }
}

/** Hosts [SubscribeSheet] over the app you're in when dictation runs out, and closes with it. */
class SubscribeActivity : AppCompatActivity() {
    companion object {
        const val HOURS = "hours"
        /** When the sheet last opened (uptime ms), so [SubscribeSheet.offer] knows Android let it open. */
        @Volatile var shownAt = 0L
    }

    private var sheet: Dialog? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        shownAt = SystemClock.uptimeMillis()
        sheet = SubscribeSheet.show(this, intent.getBooleanExtra(HOURS, false),
            "Ready. Press the mic to keep going.") { finish() }
    }

    override fun onDestroy() {
        sheet?.setOnDismissListener(null)
        sheet?.dismiss()
        super.onDestroy()
    }
}
