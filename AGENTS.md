# Selectra — Android APK Only Project

> **DŮLEŽITÉ / IMPORTANT PRO VŠECHNY BUDOUCÍ CHATY A ÚPRAVY**

Tento projekt je **čistě a výhradně určen pro nativní Android APK aplikaci** (`com.selectra.app`) běžící na Android telefonech a tabletech (Capacitor + nativní Java plugin).

## Klíčová pravidla projektu

1. **Pouze Android APK — žádné webové prohlížeče**
   - Pro webovou aplikaci existuje samostatný projekt v Google AI Studiu.
   - **Neupravujte a nepřidávejte zbytečné workaroundy ani funkce určené pouze pro webové prohlížeče** (desktop web, PWA prohlížečové fallbacky apod.).
   - Veškerý vývoj, opravy a testování směřují výhradně k chování v nainstalovaném **Android APK** (`Capacitor` WebView + `SelectraNativePlugin.java`).

2. **Distribuce a build pipeline (neměnit)**
   - APK se sestavuje automaticky přes GitHub Actions workflow `.github/workflows/build-android-apk.yml` (`npm run android:prepare` + `./gradlew assembleRelease`) a vydává se na **GitHub Releases** jako `Selectra.apk` (včetně 1-tap aktualizací uvnitř aplikace).
   - Tento způsob vydávání na GitHub Releases ponechte beze změny.

3. **Nativní Android vrstva (jediný zdroj pravdy)**
   - Kanonický zdroj nativního pluginu je:
     `android/app/src/main/java/com/selectra/app/SelectraNativePlugin.java`
   - Skript `scripts/configure-android.mjs` **nesmí přepisovat** `SelectraNativePlugin.java` — pouze ověřuje přítomnost nativních metod a aktualizuje manifest, Gradle verze/podpis a ikony.
   - Všechna oprávnění pro přímý přístup k lokálnímu úložišti (`MANAGE_EXTERNAL_STORAGE`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `requestLegacyExternalStorage`) musí zůstat zachována v `android/app/src/main/AndroidManifest.xml` i v `scripts/configure-android.mjs`.

4. **Pojmenování pro telefon i tablet**
   - Aplikace běží na telefonech i tabletech s Androidem — používejte zařízení-neutrální pojmenování **Lokální úložiště** (v kompaktní spodní liště **Úložiště**), nikoliv *V telefonu*.
