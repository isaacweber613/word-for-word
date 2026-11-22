package com.kafkasl.phonewhisper

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * The paid plan through Google Play (Isaac, 2026-11-20): the subscription "monthly", $3 a month
 * for 10 hours, and the one-time "extra_hours_4", $1 for 4 more hours that work only while
 * subscribed. Play takes the payment; Word for Word's server checks each purchase with Google
 * (server/src/google.ts) and counts the hours, so the app only passes purchases on.
 */
object Billing {
    private const val TAG = "PhoneWhisper"
    const val SUBSCRIPTION = "monthly"
    const val HOURS = "extra_hours_4"
    const val available = true

    private var client: BillingClient? = null
    private var appContext: Context? = null
    /** Called when the purchase screen the person opened finishes: null on success, else a message. */
    private var pending: ((String?) -> Unit)? = null
    private val http by lazy { OkHttpClient() }

    private fun client(context: Context, ready: (BillingClient?) -> Unit) {
        appContext = context.applicationContext
        client?.takeIf { it.isReady }?.let { ready(it); return }
        val c = client ?: BillingClient.newBuilder(context.applicationContext)
            .setListener { result, purchases -> onPurchases(result, purchases) }
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .enableAutoServiceReconnection()
            .build().also { client = it }
        c.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) =
                ready(if (result.responseCode == BillingClient.BillingResponseCode.OK) c else null)
            override fun onBillingServiceDisconnected() {}
        })
    }

    fun subscribe(activity: Activity, done: (String?) -> Unit) = buy(activity, SUBSCRIPTION, BillingClient.ProductType.SUBS, done)

    fun buyHours(activity: Activity, done: (String?) -> Unit) = buy(activity, HOURS, BillingClient.ProductType.INAPP, done)

    /** Google Play's own page for the subscription, where it can be cancelled. */
    fun manage(activity: Activity) {
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(
            "https://play.google.com/store/account/subscriptions?sku=$SUBSCRIPTION&package=${activity.packageName}")))
    }

    private fun buy(activity: Activity, product: String, type: String, done: (String?) -> Unit) {
        client(activity) { c ->
            if (c == null) { done("Google Play isn't available on this phone."); return@client }
            val params = QueryProductDetailsParams.newBuilder().setProductList(listOf(
                QueryProductDetailsParams.Product.newBuilder().setProductId(product).setProductType(type).build())).build()
            c.queryProductDetailsAsync(params) { _, result ->
                val details = result.productDetailsList.firstOrNull()
                if (details == null) { done("This isn't for sale yet. Try again later."); return@queryProductDetailsAsync }
                val item = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(details)
                details.subscriptionOfferDetails?.firstOrNull()?.let { item.setOfferToken(it.offerToken) }
                pending = done
                activity.runOnUiThread {
                    c.launchBillingFlow(activity, BillingFlowParams.newBuilder()
                        .setProductDetailsParamsList(listOf(item.build())).build())
                }
            }
        }
    }

    private fun onPurchases(result: BillingResult, purchases: List<Purchase>?) {
        val done = pending.also { pending = null }
        when (result.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                val context = appContext ?: return
                val paid = purchases.orEmpty().filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }
                if (paid.isEmpty()) { done?.invoke("Your payment is still being processed."); return }
                thread {
                    val counted = paid.map { register(context, it) }.all { it }
                    done?.invoke(if (counted) null else "Your payment went through, but Word for Word couldn't confirm it yet. " +
                        "It tries again each time you open the app.")
                }
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> {}
            BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> appContext?.let { sync(it) { done?.invoke(null) } }
            else -> done?.invoke("Google Play couldn't finish the purchase (${result.debugMessage.ifBlank { "error ${result.responseCode}" }}).")
        }
    }

    /**
     * Sends this Google account's purchases to the server again: a new phone, a renewed month, or
     * a purchase the app was closed during. Calls back true when the server says time is left.
     */
    fun sync(context: Context, done: (Boolean) -> Unit) {
        client(context) { c ->
            if (c == null) { done(false); return@client }
            c.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { _, subs ->
                c.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build()) { _, hours ->
                    thread {
                        (subs + hours).filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }
                            .forEach { register(context, it) }
                        done(!FreeMinutes.out(context))
                    }
                }
            }
        }
    }

    /**
     * Tells the server about one paid purchase; once it has counted it, Play is told it was
     * delivered. False when the server didn't count it.
     */
    private fun register(context: Context, purchase: Purchase): Boolean {
        val c = client ?: return false
        FreeMinutes.register(context)
        for (product in purchase.products) {
            val body = JSONObject().put("product_id", product).put("purchase_token", purchase.purchaseToken).toString()
            val request = FreeMinutes.identify(Request.Builder().url(BuildConfig.SERVICE_URL + "/v1/purchases"), context)
                .post(body.toRequestBody("application/json".toMediaType())).build()
            try {
                http.newCall(request).execute().use { r ->
                    val answer = JSONObject(r.body?.string() ?: "{}")
                    if (!r.isSuccessful) { Log.w(TAG, "Server didn't count $product: ${r.code}"); return false }
                    FreeMinutes.remember(context, answer.optBoolean("subscribed"), answer.optBoolean("out"))
                }
            } catch (e: Exception) { Log.w(TAG, "Couldn't send a purchase to the server", e); return false }
            if (product == HOURS) {
                c.consumeAsync(ConsumeParams.newBuilder().setPurchaseToken(purchase.purchaseToken).build()) { _, _ -> }
            } else if (!purchase.isAcknowledged) {
                c.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(purchase.purchaseToken).build()) { }
            }
        }
        return true
    }
}
