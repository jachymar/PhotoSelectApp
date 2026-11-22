#!/usr/bin/env node
/**
 * ============================================================================
 * SELECTRA — ANDROID APK ONLY PROJECT
 * ============================================================================
 * This repository is EXCLUSIVELY for the native Android APK (`com.selectra.app`)
 * built via Capacitor + GitHub Actions (`.github/workflows/build-android-apk.yml`)
 * and distributed via GitHub Releases. There is a separate project for the web app.
 *
 * Canonical native plugin source:
 *   android/app/src/main/java/com/selectra/app/SelectraNativePlugin.java
 *
 * IMPORTANT: This script NEVER overwrites `SelectraNativePlugin.java`.
 * Instead, it verifies the plugin source is intact and idempotently configures:
 *  - MainActivity.java (registers SelectraNativePlugin BEFORE super.onCreate + dark system bars)
 *  - app/build.gradle (versionName/versionCode, signingConfigs, dependencies)
 *  - AndroidManifest.xml (largeHeap, requestLegacyExternalStorage, MANAGE_EXTERNAL_STORAGE,
 *    READ/WRITE_EXTERNAL_STORAGE, VIBRATE, REQUEST_INSTALL_PACKAGES)
 *  - Dark theme colors (#09090B) & Selectra app icons
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');

if (!fs.existsSync(ANDROID_DIR)) {
  console.error('Chybí složka android/. Nejprve spusťte: npx cap add android');
  process.exit(1);
}

const JAVA_PKG_DIR = path.join(
  ANDROID_DIR,
  'app',
  'src',
  'main',
  'java',
  'com',
  'selectra',
  'app'
);
fs.mkdirSync(JAVA_PKG_DIR, { recursive: true });

// 1. Verify canonical SelectraNativePlugin.java (NEVER overwrite it!)
const pluginJavaPath = path.join(JAVA_PKG_DIR, 'SelectraNativePlugin.java');
if (!fs.existsSync(pluginJavaPath)) {
  console.error(
    `Chybí kanonický zdrojový soubor nativního pluginu: ${pluginJavaPath}`
  );
  process.exit(1);
}

const pluginSrc = fs.readFileSync(pluginJavaPath, 'utf8');
const requiredMethods = [
  'getStoragePermissionStatus',
  'requestAllFilesAccess',
  'listStorageRoots',
  'attachSafRoot',
  'removeSafRoot',
  'listLocalDirectory',
  'openLocalDirectory',
];
const missingMethods = requiredMethods.filter(
  (name) => !pluginSrc.includes(`public void ${name}(`)
);
if (missingMethods.length > 0) {
  console.error(
    `SelectraNativePlugin.java postrádá povinné nativní metody: ${missingMethods.join(', ')}`
  );
  process.exit(1);
}

// 2. Write MainActivity.java (MUST register SelectraNativePlugin BEFORE super.onCreate!)
const cleanMainActivityJava = `package com.selectra.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;

import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(SelectraNativePlugin.class);
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        if (window != null) {
            int bg = Color.parseColor("#09090B");
            window.setStatusBarColor(bg);
            window.setNavigationBarColor(bg);
            WindowInsetsControllerCompat controller =
                new WindowInsetsControllerCompat(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(false);
            controller.setAppearanceLightNavigationBars(false);
        }
    }
}
`;

fs.writeFileSync(
  path.join(JAVA_PKG_DIR, 'MainActivity.java'),
  cleanMainActivityJava,
  'utf8'
);

// 3. Patch android/app/build.gradle
const appGradlePath = path.join(ANDROID_DIR, 'app', 'build.gradle');
if (fs.existsSync(appGradlePath)) {
  let gradle = fs.readFileSync(appGradlePath, 'utf8');

  const targetVersionName = (
    process.env.ANDROID_VERSION_NAME || '2.16.0'
  ).replace(/^v/i, '');
  const parsedCode = Number.parseInt(
    process.env.ANDROID_VERSION_CODE || '302',
    10
  );
  const targetVersionCode =
    Number.isFinite(parsedCode) && parsedCode > 0 ? parsedCode : 302;

  gradle = gradle.replace(
    /versionName\s+"[^"]*"/,
    `versionName "${targetVersionName}"`
  );
  gradle = gradle.replace(
    /versionCode\s+\d+/,
    `versionCode ${targetVersionCode}`
  );

  if (!gradle.includes('ANDROID_KEYSTORE_PATH')) {
    gradle = gradle.replace(
      /buildTypes\s*\{\s*release\s*\{/,
      `signingConfigs {
        release {
            def ksPath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (ksPath != null && !ksPath.isEmpty() && file(ksPath).exists()) {
                storeFile file(ksPath)
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            def ksPath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (ksPath != null && !ksPath.isEmpty() && file(ksPath).exists()) {
                signingConfig signingConfigs.release
            } else {
                signingConfig signingConfigs.debug
            }`
    );
  }

  if (!gradle.includes('play-services-auth')) {
    gradle = gradle.replace(
      /dependencies\s*\{/,
      `dependencies {
    implementation "androidx.documentfile:documentfile:1.0.1"
    implementation "androidx.exifinterface:exifinterface:1.3.7"
    implementation "com.google.android.gms:play-services-auth:21.2.0"`
    );
  }

  fs.writeFileSync(appGradlePath, gradle, 'utf8');
}

// 4. Patch AndroidManifest.xml (All-Files Access, legacy storage, VIBRATE, APK installer, largeHeap)
const manifestPath = path.join(
  ANDROID_DIR,
  'app',
  'src',
  'main',
  'AndroidManifest.xml'
);
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf8');

  if (!manifest.includes('xmlns:tools=')) {
    manifest = manifest.replace(
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:tools="http://schemas.android.com/tools"'
    );
  }
  if (!manifest.includes('android:largeHeap=')) {
    manifest = manifest.replace(
      '<application',
      '<application\n        android:largeHeap="true"'
    );
  }
  if (!manifest.includes('android:requestLegacyExternalStorage=')) {
    manifest = manifest.replace(
      '<application',
      '<application\n        android:requestLegacyExternalStorage="true"'
    );
  }
  if (!manifest.includes('android.permission.VIBRATE')) {
    manifest = manifest.replace(
      '</manifest>',
      '    <uses-permission android:name="android.permission.VIBRATE" />\n</manifest>'
    );
  }
  if (!manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES')) {
    manifest = manifest.replace(
      '</manifest>',
      '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n</manifest>'
    );
  }
  if (!manifest.includes('android.permission.MANAGE_EXTERNAL_STORAGE')) {
    manifest = manifest.replace(
      '</manifest>',
      '    <uses-permission\n        android:name="android.permission.MANAGE_EXTERNAL_STORAGE"\n        tools:ignore="ScopedStorage" />\n</manifest>'
    );
  }
  if (!manifest.includes('android.permission.READ_EXTERNAL_STORAGE')) {
    manifest = manifest.replace(
      '</manifest>',
      '    <uses-permission\n        android:name="android.permission.READ_EXTERNAL_STORAGE"\n        android:maxSdkVersion="32" />\n</manifest>'
    );
  }
  if (!manifest.includes('android.permission.WRITE_EXTERNAL_STORAGE')) {
    manifest = manifest.replace(
      '</manifest>',
      '    <uses-permission\n        android:name="android.permission.WRITE_EXTERNAL_STORAGE"\n        android:maxSdkVersion="29" />\n</manifest>'
    );
  }

  fs.writeFileSync(manifestPath, manifest, 'utf8');
}

// 5. Update colors.xml, ic_launcher_background.xml, and styles.xml to match Selectra darkroom theme (#09090B)
const valuesDir = path.join(ANDROID_DIR, 'app', 'src', 'main', 'res', 'values');
fs.mkdirSync(valuesDir, { recursive: true });
fs.writeFileSync(
  path.join(valuesDir, 'colors.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#09090B</color>
    <color name="colorPrimaryDark">#09090B</color>
    <color name="colorAccent">#F59E0B</color>
</resources>
`,
  'utf8'
);

fs.writeFileSync(
  path.join(valuesDir, 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#09090B</color>
</resources>
`,
  'utf8'
);

const stylesPath = path.join(valuesDir, 'styles.xml');
if (fs.existsSync(stylesPath)) {
  let styles = fs.readFileSync(stylesPath, 'utf8');
  if (!styles.includes('android:windowBackground')) {
    styles = styles.replace(
      '<item name="android:background">@null</item>',
      `<item name="android:background">@null</item>
        <item name="android:windowBackground">@color/colorPrimary</item>
        <item name="android:statusBarColor">@color/colorPrimaryDark</item>
        <item name="android:navigationBarColor">@color/colorPrimaryDark</item>`
    );
    fs.writeFileSync(stylesPath, styles, 'utf8');
  }
}

// 6. Copy Selectra icons into mipmap launcher slots (transparent adaptive foreground + dark launcher base)
const srcIcon512 = path.join(ROOT, 'public', 'pwa-512x512.png');
const srcIcon192 = path.join(ROOT, 'public', 'pwa-192x192.png');
const srcAdaptiveFg = path.join(__dirname, 'android-foreground-512x512.png');
const srcMaskable = path.join(ROOT, 'public', 'pwa-maskable-512x512.png');

if (fs.existsSync(srcIcon512)) {
  const resDir = path.join(ANDROID_DIR, 'app', 'src', 'main', 'res');
  const mipmapDirs = [
    'mipmap-mdpi',
    'mipmap-hdpi',
    'mipmap-xhdpi',
    'mipmap-xxhdpi',
    'mipmap-xxxhdpi',
  ];
  for (const dirName of mipmapDirs) {
    const targetDir = path.join(resDir, dirName);
    if (!fs.existsSync(targetDir)) continue;
    const baseIcon =
      dirName === 'mipmap-mdpi' || dirName === 'mipmap-hdpi'
        ? fs.existsSync(srcIcon192)
          ? srcIcon192
          : srcIcon512
        : srcIcon512;
    const fgIcon = fs.existsSync(srcAdaptiveFg)
      ? srcAdaptiveFg
      : fs.existsSync(srcMaskable)
        ? srcMaskable
        : srcIcon512;

    for (const fileName of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const p = path.join(targetDir, fileName);
      if (fs.existsSync(p)) fs.copyFileSync(baseIcon, p);
    }
    const fgPath = path.join(targetDir, 'ic_launcher_foreground.png');
    if (fs.existsSync(fgPath)) fs.copyFileSync(fgIcon, fgPath);
  }
}

console.log(
  'Android APK projekt (SelectraNativePlugin ověřen + MainActivity + manifest + ikony) je připraven.'
);
