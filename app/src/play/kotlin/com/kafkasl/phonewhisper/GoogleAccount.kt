package com.kafkasl.phonewhisper

import android.app.Activity
import android.content.Context
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential

/**
 * "Sign in with Google" in the Play build, so hours Isaac gave a Google email reach that person's
 * phones (Access.useGoogle). Android's Credential Manager shows Google's own account picker and gives
 * an ID token for the server's web client ID (Google Cloud project "Word for Word"), which the server
 * checks with Google's keys (developer.android.com/identity/sign-in/credential-manager-siwg).
 */
object GoogleAccount {
    const val available = true

    /** Calls back on the main thread with an ID token, or an error to show; both null when the person cancelled. */
    fun signIn(activity: Activity, callback: (idToken: String?, error: String?) -> Unit) {
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(GetSignInWithGoogleOption.Builder(BuildConfig.GOOGLE_WEB_CLIENT_ID).build())
            .build()
        CredentialManager.create(activity).getCredentialAsync(activity, request, CancellationSignal(),
            ContextCompat.getMainExecutor(activity),
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) {
                    val c = result.credential
                    val token = if (c is CustomCredential && c.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                        try { GoogleIdTokenCredential.createFrom(c.data).idToken } catch (e: Exception) { null }
                    } else null
                    if (token != null) callback(token, null) else callback(null, "Google sign-in didn't work. Try again.")
                }

                override fun onError(e: GetCredentialException) {
                    if (e is GetCredentialCancellationException) callback(null, null)
                    else callback(null, "Google sign-in didn't work (${e.type.substringAfterLast('.')}). Try again.")
                }
            })
    }

    /** Lets the next sign-in pick any account again. */
    fun signOut(context: Context) {
        CredentialManager.create(context).clearCredentialStateAsync(ClearCredentialStateRequest(), null,
            ContextCompat.getMainExecutor(context),
            object : CredentialManagerCallback<Void?, ClearCredentialException> {
                override fun onResult(result: Void?) {}
                override fun onError(e: ClearCredentialException) {}
            })
    }
}
