# JCM Landscaping Android App

## Installing the Debug APK

1. Transfer `JCM-Landscaping-debug.apk` to your Android device
2. On the device, go to Settings > Security > Enable "Install from Unknown Sources" or "Install Unknown Apps"
3. Open the APK file and tap Install
4. The app will appear as "JCM Landscaping" with the green leaf icon

## For Production Release (Google Play)

To build a signed release APK for Google Play:

1. Generate a keystore: `keytool -genkey -v -keystore jcm-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias jcm`
2. Build release: `./gradlew assembleRelease`
3. Sign with your keystore using Android Studio or jarsigner
4. Upload to Google Play Console at `play.google.com/console`

## Authentication on Android

The mobile app uses the deployed JCM server-side account API with email/password sign-in. Passwords are stored as salted hashes in the private GitHub data repository. Phone verification is intentionally unavailable until an SMS provider is configured.

After changing `jcm-mobile/www`, run `npx cap sync android` from `jcm-mobile` before building a new APK.

The editable mobile web source is present in `jcm-mobile/www`. Keep `index.html`, `workflow-overrides.js`, `marketplace-ui.js`, `privacy.html`, and `terms.html` synchronized with the website workflow. Stripe remains Sandbox / Test Mode only in the mobile wrapper; no live keys belong in the APK or bundled web assets.
