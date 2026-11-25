import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Upload-key details live in keystore.properties, which is never committed.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.kafkasl.phonewhisper"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.isaacweber.wordforword"
        minSdk = 23
        targetSdk = 36
        versionCode = 54
        versionName = "0.9.17"

        ndk { abiFilters += "arm64-v8a" }

        // Instrumented tests (app/src/androidTest), run by scripts/release.sh on an emulator.
        testInstrumentationRunner = "com.kafkasl.phonewhisper.TestRunner"
    }

    buildFeatures { buildConfig = true }

    // Anonymous usage counts (Analytics.kt). A PostHog project key is public by design: it can
    // only send events, not read them. Empty turns analytics off.
    defaultConfig {
        buildConfigField("String", "POSTHOG_KEY", "\"phc_BjYGs7MHnDDkKMYWY7Cod5AiHWMLubtbEoC3XCrg5sjo\"")
        buildConfigField("String", "POSTHOG_HOST", "\"https://us.i.posthog.com\"")
    }

    // Three builds from the same code. All have the keyboard shortcut and run on Android 6+.
    // They differ only in how updates arrive:
    //   browser:     WordForWord.apk on GitHub. Update opens the new APK in the browser.
    //   selfInstall: WordForWordSelfUpdate.apk on GitHub. The app downloads and installs its own
    //                updates. Needs REQUEST_INSTALL_PACKAGES, which makes Play Protect block it.
    //   play:        the Google Play app bundle. No update check at all: Play installs updates,
    //                and Play policy bans apps that update themselves any other way.
    flavorDimensions += "updates"
    productFlavors {
        create("browser") {
            dimension = "updates"
            buildConfigField("String", "APK_NAME", "\"WordForWord.apk\"")
            buildConfigField("boolean", "UPDATES", "true")
            // No free minutes here; the server is used only with an access code (Access.kt).
            buildConfigField("String", "SERVICE_URL", "\"https://word-for-word.ynbsd6242.workers.dev\"")
        }
        create("selfInstall") {
            dimension = "updates"
            buildConfigField("String", "APK_NAME", "\"WordForWordSelfUpdate.apk\"")
            buildConfigField("boolean", "UPDATES", "true")
            // No free minutes here; the server is used only with an access code (Access.kt).
            buildConfigField("String", "SERVICE_URL", "\"https://word-for-word.ynbsd6242.workers.dev\"")
        }
        create("play") {
            dimension = "updates"
            buildConfigField("String", "APK_NAME", "\"\"")
            buildConfigField("boolean", "UPDATES", "false")
            // Free minutes through Word for Word's server (server/, FreeMinutes.kt). -PserviceUrl=... points a
            // test build at a preview copy of the server (wrangler versions upload); releases never set it.
            val serviceUrl = (project.findProperty("serviceUrl") as String?) ?: "https://word-for-word.ynbsd6242.workers.dev"
            buildConfigField("String", "SERVICE_URL", "\"$serviceUrl\"")
        }
    }

    // Billing (the paid plan) is only in the Play build; the GitHub builds get a stand-in that sells nothing.
    sourceSets["browser"].kotlin.srcDir("src/github/kotlin")
    sourceSets["selfInstall"].kotlin.srcDir("src/github/kotlin")

    signingConfigs {
        if (keystoreProps.getProperty("storeFile") != null) {
            create("upload") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    // Only the Play build uses the private upload key. The GitHub builds are signed with the
    // debug key by scripts/release.sh, because a different key can't install over earlier releases.
    productFlavors.getByName("play").signingConfig = signingConfigs.findByName("upload")

    buildTypes {
        release {
            // Remove library code and resources the app never uses.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    @Suppress("DEPRECATION")
    kotlinOptions { jvmTarget = "17" }

    testOptions { unitTests { isIncludeAndroidResources = true } }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.apache.commons:commons-compress:1.27.1")
    implementation("com.posthog:posthog-android:3.76.1")
    // Google Play Billing, for the $3 subscription and $1 hours (Billing.kt). Play build only.
    "playImplementation"("com.android.billingclient:billing:9.1.0")
    // Google Play Integrity, so the free-minutes server serves only the Play app (Integrity.kt). Play build only.
    "playImplementation"("com.google.android.play:integrity:1.6.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")

    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
