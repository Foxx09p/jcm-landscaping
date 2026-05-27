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

## Google Sign-In on Android

For Google Sign-In to work in the native app, you need to:

1. Go to Google Cloud Console > APIs & Services > Credentials
2. Create an OAuth 2.0 Android client ID
3. Use your app's SHA-1 fingerprint: run `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android`
4. Add the SHA-1 to the Android client in Google Cloud Console
5. Update the `serverClientId` in `jcm-mobile/capacitor.config.json` with the Android client ID
