# Selectra (Android APK)

**Tento projekt je určen výhradně pro nativní Android APK aplikaci (`com.selectra.app`)** pro telefony a tablety s Androidem. Webová verze aplikace je vedena v samostatném projektu.

## Build a vydávání

- Sestavení podepsaného `Selectra.apk` a vydání nové verze probíhá automaticky přes GitHub Actions (`.github/workflows/build-android-apk.yml`) přímo na **GitHub Releases**.
- Nativní Android plugin je udržován přímo v `android/app/src/main/java/com/selectra/app/SelectraNativePlugin.java` (skript `scripts/configure-android.mjs` jej nepřepisuje).

Viz také `AGENTS.md` pro podrobná pravidla projektu.
