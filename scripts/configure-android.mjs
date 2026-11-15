#!/usr/bin/env node
/**
 * Idempotent post-setup configurator for the Capacitor Android project (`android/`).
 * Injects:
 *  - SelectraNativePlugin.java (Storage Access Framework tree R/W, fast byte-slice RAW reader,
 *    subsampled thumbnails, native haptics, and permanent Google Sign-In + silent Drive refresh)
 *  - MainActivity.java (registers SelectraNativePlugin BEFORE super.onCreate + dark system bars)
 *  - app/build.gradle dependencies & automatic release/debug APK signing
 *  - AndroidManifest.xml permissions & largeHeap
 *  - Dark theme colors (#09090B) & Selectra app icons from public/pwa-512x512.png
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

// 1. Write SelectraNativePlugin.java
const pluginJava = `package com.selectra.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.graphics.Point;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.exifinterface.media.ExifInterface;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.UserRecoverableAuthException;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "SelectraNative")
public class SelectraNativePlugin extends Plugin {

    private static final String PREFS_SAF = "selectra_saf_trees_v1";
    private static final String DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

    private static final Set<String> IGNORED_DIRS = new HashSet<>(Arrays.asList(
        "liked",
        "_vyrazene",
        "_trash",
        ".trash",
        ".trashed",
        "lost.dir",
        "system volume information",
        ".android_secure"
    ));

    private static final Set<String> SUPPORTED_EXTS = new HashSet<>(Arrays.asList(
        "jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "gif", "bmp", "tif", "tiff",
        "cr3", "cr2", "crw", "nef", "nrw", "arw", "sr2", "srf", "dng", "raf", "orf", "rw2",
        "pef", "raw", "rwl", "iiq", "3fr"
    ));

    private static final Set<String> RASTER_THUMB_EXTS = new HashSet<>(Arrays.asList(
        "jpg", "jpeg", "png", "webp", "bmp", "heic", "heif"
    ));

    private static final String[] DOC_PROJECTION = new String[] {
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED
    };

    private final ExecutorService ioExecutor = Executors.newFixedThreadPool(4);
    private GoogleSignInAccount pendingConsentAccount = null;

    private String computeFolderId(Uri treeUri) {
        int hash = treeUri.toString().hashCode();
        return "saf-tree-" + Integer.toUnsignedString(hash, 36);
    }

    private String extractFolderDisplayName(ContentResolver resolver, Uri treeUri) {
        try {
            String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocId);
            try (Cursor c = resolver.query(
                docUri,
                new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME },
                null,
                null,
                null
            )) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) {
                    String name = c.getString(0);
                    if (name != null && !name.trim().isEmpty()) {
                        return name.trim();
                    }
                }
            }
            if (rootDocId != null) {
                int slash = rootDocId.lastIndexOf('/');
                if (slash >= 0 && slash + 1 < rootDocId.length()) {
                    return rootDocId.substring(slash + 1);
                }
                int colon = rootDocId.lastIndexOf(':');
                if (colon >= 0 && colon + 1 < rootDocId.length()) {
                    return rootDocId.substring(colon + 1);
                }
            }
        } catch (Exception ignored) {
        }
        return "Složka v telefonu";
    }

    private void savePersistedTree(String folderId, String folderName, Uri treeUri) {
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS_SAF, Context.MODE_PRIVATE);
            JSONObject obj = new JSONObject();
            obj.put("folderId", folderId);
            obj.put("folderName", folderName);
            obj.put("treeUri", treeUri.toString());
            obj.put("updatedAtMs", System.currentTimeMillis());
            prefs.edit().putString(folderId, obj.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private Uri getPersistedTreeUri(String folderId) {
        if (folderId == null || folderId.isEmpty()) return null;
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS_SAF, Context.MODE_PRIVATE);
            String raw = prefs.getString(folderId, null);
            if (raw == null) return null;
            JSONObject obj = new JSONObject(raw);
            String uriStr = obj.optString("treeUri", "");
            if (uriStr.isEmpty()) return null;
            return Uri.parse(uriStr);
        } catch (Exception e) {
            return null;
        }
    }

    private boolean hasValidPersistedPermission(ContentResolver resolver, Uri treeUri) {
        List<UriPermission> perms = resolver.getPersistedUriPermissions();
        String target = treeUri.toString();
        for (UriPermission p : perms) {
            if (p.getUri().toString().equals(target) && p.isReadPermission()) {
                return true;
            }
        }
        return false;
    }

    private static String getExtensionLower(String name) {
        if (name == null) return "";
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot + 1 >= name.length()) return "";
        return name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static boolean isSupportedPhotoEntry(String name, String mime) {
        String ext = getExtensionLower(name);
        if (SUPPORTED_EXTS.contains(ext)) return true;
        return mime != null && mime.startsWith("image/");
    }

    private void scanDirectoryRecursive(
        ContentResolver resolver,
        Uri treeUri,
        String folderId,
        String parentDocId,
        String relativePrefix,
        int depth,
        JSArray outFiles
    ) {
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId);
        try (Cursor c = resolver.query(childrenUri, DOC_PROJECTION, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String docId = c.getString(0);
                String name = c.isNull(1) ? "" : c.getString(1);
                String mime = c.isNull(2) ? "" : c.getString(2);
                long size = c.isNull(3) ? 0L : c.getLong(3);
                long lastMod = c.isNull(4) ? 0L : c.getLong(4);

                if (docId == null || name == null || name.isEmpty()) continue;

                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    if (depth < 2) {
                        String lower = name.trim().toLowerCase(Locale.ROOT);
                        if (!lower.startsWith(".") && !IGNORED_DIRS.contains(lower)) {
                            String nextPrefix = relativePrefix.isEmpty()
                                ? name
                                : (relativePrefix + "/" + name);
                            scanDirectoryRecursive(
                                resolver,
                                treeUri,
                                folderId,
                                docId,
                                nextPrefix,
                                depth + 1,
                                outFiles
                            );
                        }
                    }
                } else {
                    if (name.startsWith(".")) continue;
                    if (!isSupportedPhotoEntry(name, mime)) continue;

                    Uri fileUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
                    String relPath = relativePrefix.isEmpty()
                        ? name
                        : (relativePrefix + "/" + name);

                    JSObject item = new JSObject();
                    item.put("id", "saf:" + folderId + ":" + docId);
                    item.put("uri", fileUri.toString());
                    item.put("name", name);
                    item.put("relativePath", relPath);
                    item.put("mimeType", mime);
                    item.put("sizeBytes", size);
                    item.put("lastModifiedMs", lastMod);
                    outFiles.put(item);
                }
            }
        } catch (Exception ignored) {
        }
    }

    @PluginMethod
    public void pickDirectoryTree(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        startActivityForResult(call, intent, "handlePickDirectoryResult");
    }

    @ActivityCallback
    private void handlePickDirectoryResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        final Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        ioExecutor.execute(() -> {
            try {
                ContentResolver resolver = getContext().getContentResolver();
                final int takeFlags =
                    Intent.FLAG_GRANT_READ_URI_PERMISSION |
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
                try {
                    resolver.takePersistableUriPermission(treeUri, takeFlags);
                } catch (SecurityException se) {
                    try {
                        resolver.takePersistableUriPermission(
                            treeUri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION
                        );
                    } catch (Exception ignored) {
                    }
                }

                String folderId = computeFolderId(treeUri);
                String folderName = extractFolderDisplayName(resolver, treeUri);
                savePersistedTree(folderId, folderName, treeUri);

                String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
                JSArray files = new JSArray();
                scanDirectoryRecursive(resolver, treeUri, folderId, rootDocId, "", 0, files);

                JSObject ret = new JSObject();
                ret.put("folderId", folderId);
                ret.put("folderName", folderName);
                ret.put("files", files);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Nepodařilo se načíst vybranou složku: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void listPersistedFolders(PluginCall call) {
        ioExecutor.execute(() -> {
            JSArray folders = new JSArray();
            try {
                ContentResolver resolver = getContext().getContentResolver();
                SharedPreferences prefs = getContext().getSharedPreferences(PREFS_SAF, Context.MODE_PRIVATE);
                Map<String, ?> all = prefs.getAll();
                for (Map.Entry<String, ?> entry : all.entrySet()) {
                    Object rawVal = entry.getValue();
                    if (!(rawVal instanceof String)) continue;
                    try {
                        JSONObject obj = new JSONObject((String) rawVal);
                        String uriStr = obj.optString("treeUri", "");
                        if (uriStr.isEmpty()) continue;
                        Uri treeUri = Uri.parse(uriStr);
                        if (!hasValidPersistedPermission(resolver, treeUri)) {
                            continue;
                        }
                        JSObject item = new JSObject();
                        item.put("folderId", obj.optString("folderId", entry.getKey()));
                        item.put("folderName", obj.optString("folderName", "Složka v telefonu"));
                        item.put("treeUri", uriStr);
                        item.put("updatedAtMs", obj.optLong("updatedAtMs", 0L));
                        folders.put(item);
                    } catch (Exception ignored) {
                    }
                }
            } catch (Exception ignored) {
            }
            JSObject ret = new JSObject();
            ret.put("folders", folders);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void openPersistedDirectoryTree(PluginCall call) {
        final String folderId = call.getString("folderId", "");
        if (folderId == null || folderId.isEmpty()) {
            call.reject("Chybí identifikátor složky.");
            return;
        }
        ioExecutor.execute(() -> {
            try {
                ContentResolver resolver = getContext().getContentResolver();
                Uri treeUri = getPersistedTreeUri(folderId);
                if (treeUri == null || !hasValidPersistedPermission(resolver, treeUri)) {
                    call.reject("Oprávnění k uložené složce vypršelo.");
                    return;
                }
                String folderName = extractFolderDisplayName(resolver, treeUri);
                savePersistedTree(folderId, folderName, treeUri);

                String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
                JSArray files = new JSArray();
                scanDirectoryRecursive(resolver, treeUri, folderId, rootDocId, "", 0, files);

                JSObject ret = new JSObject();
                ret.put("folderId", folderId);
                ret.put("folderName", folderName);
                ret.put("files", files);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Nepodařilo se znovu otevřít složku: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void forgetPersistedFolder(PluginCall call) {
        String folderId = call.getString("folderId", "");
        if (folderId != null && !folderId.isEmpty()) {
            try {
                Uri treeUri = getPersistedTreeUri(folderId);
                SharedPreferences prefs = getContext().getSharedPreferences(PREFS_SAF, Context.MODE_PRIVATE);
                prefs.edit().remove(folderId).apply();
                if (treeUri != null) {
                    getContext().getContentResolver().releasePersistableUriPermission(
                        treeUri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    );
                }
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    private String findSubfolderDocId(ContentResolver resolver, Uri treeUri, String parentDocId, String subfolderName) {
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId);
        String[] proj = new String[] {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        };
        try (Cursor c = resolver.query(childrenUri, proj, null, null, null)) {
            if (c == null) return null;
            while (c.moveToNext()) {
                String docId = c.getString(0);
                String name = c.isNull(1) ? "" : c.getString(1);
                String mime = c.isNull(2) ? "" : c.getString(2);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime) &&
                    name != null &&
                    name.trim().equalsIgnoreCase(subfolderName.trim())) {
                    return docId;
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private String findOrCreateSubfolderDocId(ContentResolver resolver, Uri treeUri, String subfolderName) throws Exception {
        String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
        String existing = findSubfolderDocId(resolver, treeUri, rootDocId, subfolderName);
        if (existing != null) return existing;

        Uri rootDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocId);
        Uri createdUri = DocumentsContract.createDocument(
            resolver,
            rootDocUri,
            DocumentsContract.Document.MIME_TYPE_DIR,
            subfolderName
        );
        if (createdUri == null) {
            throw new IllegalStateException("Android nepovolil vytvořit podsložku " + subfolderName);
        }
        return DocumentsContract.getDocumentId(createdUri);
    }

    private Set<String> readChildFileNamesLower(ContentResolver resolver, Uri treeUri, String dirDocId) {
        Set<String> names = new HashSet<>();
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, dirDocId);
        String[] proj = new String[] {
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        };
        try (Cursor c = resolver.query(childrenUri, proj, null, null, null)) {
            if (c == null) return names;
            while (c.moveToNext()) {
                String name = c.isNull(0) ? "" : c.getString(0);
                String mime = c.isNull(1) ? "" : c.getString(1);
                if (!DocumentsContract.Document.MIME_TYPE_DIR.equals(mime) &&
                    name != null &&
                    !name.trim().isEmpty()) {
                    names.add(name.trim().toLowerCase(Locale.ROOT));
                }
            }
        } catch (Exception ignored) {
        }
        return names;
    }

    @PluginMethod
    public void listSubfolderFileNames(PluginCall call) {
        final String folderId = call.getString("folderId", "");
        final String subfolderName = call.getString("subfolderName", "Liked");
        ioExecutor.execute(() -> {
            JSArray arr = new JSArray();
            try {
                Uri treeUri = getPersistedTreeUri(folderId);
                if (treeUri != null) {
                    ContentResolver resolver = getContext().getContentResolver();
                    String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
                    String subDocId = findSubfolderDocId(resolver, treeUri, rootDocId, subfolderName);
                    if (subDocId != null) {
                        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, subDocId);
                        String[] proj = new String[] {
                            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                            DocumentsContract.Document.COLUMN_MIME_TYPE
                        };
                        try (Cursor c = resolver.query(childrenUri, proj, null, null, null)) {
                            if (c != null) {
                                while (c.moveToNext()) {
                                    String name = c.isNull(0) ? "" : c.getString(0);
                                    String mime = c.isNull(1) ? "" : c.getString(1);
                                    if (!DocumentsContract.Document.MIME_TYPE_DIR.equals(mime) &&
                                        name != null &&
                                        !name.trim().isEmpty()) {
                                        arr.put(name.trim());
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            JSObject ret = new JSObject();
            ret.put("names", arr);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void readFileSlice(PluginCall call) {
        final String uriStr = call.getString("uri", "");
        final long start = Math.max(0L, call.getLong("start", 0L));
        final long end = Math.max(start, call.getLong("end", 0L));

        if (uriStr == null || uriStr.isEmpty()) {
            call.reject("Chybí URI souboru.");
            return;
        }

        ioExecutor.execute(() -> {
            try {
                int maxLen = (int) Math.min(24L * 1024L * 1024L, (end - start) + 1L);
                Uri uri = Uri.parse(uriStr);
                ContentResolver resolver = getContext().getContentResolver();

                byte[] outBytes;
                try (ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "r")) {
                    if (pfd != null) {
                        try (FileInputStream fis = new FileInputStream(pfd.getFileDescriptor());
                             FileChannel channel = fis.getChannel()) {
                            long fileSize = channel.size();
                            if (fileSize > 0 && start >= fileSize) {
                                outBytes = new byte[0];
                            } else {
                                int toRead = fileSize > 0
                                    ? (int) Math.min((long) maxLen, fileSize - start)
                                    : maxLen;
                                ByteBuffer buffer = ByteBuffer.allocate(toRead);
                                channel.position(start);
                                int total = 0;
                                while (total < toRead) {
                                    int r = channel.read(buffer);
                                    if (r <= 0) break;
                                    total += r;
                                }
                                if (total == toRead) {
                                    outBytes = buffer.array();
                                } else {
                                    outBytes = Arrays.copyOf(buffer.array(), total);
                                }
                            }
                        }
                    } else {
                        outBytes = new byte[0];
                    }
                } catch (Exception fallbackEx) {
                    try (InputStream is = resolver.openInputStream(uri)) {
                        if (is == null) throw fallbackEx;
                        long remainingSkip = start;
                        while (remainingSkip > 0) {
                            long skipped = is.skip(remainingSkip);
                            if (skipped <= 0) {
                                if (is.read() == -1) break;
                                skipped = 1;
                            }
                            remainingSkip -= skipped;
                        }
                        ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.min(maxLen, 65536));
                        byte[] chunk = new byte[16384];
                        int left = maxLen;
                        while (left > 0) {
                            int r = is.read(chunk, 0, Math.min(chunk.length, left));
                            if (r <= 0) break;
                            bos.write(chunk, 0, r);
                            left -= r;
                        }
                        outBytes = bos.toByteArray();
                    }
                }

                String b64 = Base64.encodeToString(outBytes, Base64.NO_WRAP);
                JSObject ret = new JSObject();
                ret.put("data", b64);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Chyba při čtení souboru: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void getThumbnail(PluginCall call) {
        final String uriStr = call.getString("uri", "");
        if (uriStr == null || uriStr.isEmpty()) {
            JSObject empty = new JSObject();
            empty.put("dataUrl", JSObject.NULL);
            call.resolve(empty);
            return;
        }

        ioExecutor.execute(() -> {
            String dataUrl = null;
            try {
                Uri uri = Uri.parse(uriStr);
                ContentResolver resolver = getContext().getContentResolver();
                Bitmap bmp = null;

                try {
                    bmp = DocumentsContract.getDocumentThumbnail(
                        resolver,
                        uri,
                        new Point(220, 220),
                        null
                    );
                } catch (Exception ignored) {
                }

                if (bmp == null) {
                    String ext = getExtensionLower(uri.getLastPathSegment());
                    if (RASTER_THUMB_EXTS.contains(ext)) {
                        BitmapFactory.Options bounds = new BitmapFactory.Options();
                        bounds.inJustDecodeBounds = true;
                        try (InputStream boundsIn = resolver.openInputStream(uri)) {
                            if (boundsIn != null) {
                                BitmapFactory.decodeStream(boundsIn, null, bounds);
                            }
                        }
                        if (bounds.outWidth > 0 && bounds.outHeight > 0) {
                            int sample = 1;
                            int maxDim = Math.max(bounds.outWidth, bounds.outHeight);
                            while (maxDim / (sample * 2) >= 220) {
                                sample *= 2;
                            }
                            BitmapFactory.Options decodeOpts = new BitmapFactory.Options();
                            decodeOpts.inSampleSize = sample;
                            decodeOpts.inPreferredConfig = Bitmap.Config.RGB_565;
                            try (InputStream imgIn = resolver.openInputStream(uri)) {
                                if (imgIn != null) {
                                    bmp = BitmapFactory.decodeStream(imgIn, null, decodeOpts);
                                }
                            }
                            if (bmp != null) {
                                try (InputStream exifIn = resolver.openInputStream(uri)) {
                                    if (exifIn != null) {
                                        ExifInterface exif = new ExifInterface(exifIn);
                                        int orientation = exif.getAttributeInt(
                                            ExifInterface.TAG_ORIENTATION,
                                            ExifInterface.ORIENTATION_NORMAL
                                        );
                                        int deg = 0;
                                        if (orientation == ExifInterface.ORIENTATION_ROTATE_90) deg = 90;
                                        else if (orientation == ExifInterface.ORIENTATION_ROTATE_180) deg = 180;
                                        else if (orientation == ExifInterface.ORIENTATION_ROTATE_270) deg = 270;
                                        if (deg != 0) {
                                            Matrix m = new Matrix();
                                            m.postRotate(deg);
                                            Bitmap rotated = Bitmap.createBitmap(
                                                bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true
                                            );
                                            if (rotated != bmp) {
                                                bmp.recycle();
                                                bmp = rotated;
                                            }
                                        }
                                    }
                                } catch (Exception ignored) {
                                }
                            }
                        }
                    }
                }

                if (bmp != null) {
                    ByteArrayOutputStream bos = new ByteArrayOutputStream(12288);
                    bmp.compress(Bitmap.CompressFormat.JPEG, 76, bos);
                    bmp.recycle();
                    dataUrl = "data:image/jpeg;base64," +
                        Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                }
            } catch (Exception ignored) {
            }

            JSObject ret = new JSObject();
            ret.put("dataUrl", dataUrl != null ? dataUrl : JSObject.NULL);
            call.resolve(ret);
        });
    }

    private String[] queryNameAndMime(ContentResolver resolver, Uri fileUri) {
        String name = "photo.jpg";
        String mime = "application/octet-stream";
        String[] proj = new String[] {
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        };
        try (Cursor c = resolver.query(fileUri, proj, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                if (!c.isNull(0) && c.getString(0) != null) name = c.getString(0);
                if (!c.isNull(1) && c.getString(1) != null) mime = c.getString(1);
            }
        } catch (Exception ignored) {
        }
        return new String[] { name, mime };
    }

    private Uri resolveTreeUriWithFallback(String folderId, JSONArray fileUris) {
        Uri treeUri = getPersistedTreeUri(folderId);
        if (treeUri != null) return treeUri;
        if (fileUris != null && fileUris.length() > 0) {
            try {
                Uri first = Uri.parse(fileUris.getString(0));
                String treeDocId = DocumentsContract.getTreeDocumentId(first);
                if (treeDocId != null && first.getAuthority() != null) {
                    return DocumentsContract.buildTreeDocumentUri(first.getAuthority(), treeDocId);
                }
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private void executeSubfolderTransfer(PluginCall call, final boolean deleteSourceAfter) {
        final String folderId = call.getString("folderId", "");
        final String subfolderName = call.getString("subfolderName", "Liked");
        final JSArray urisArray = call.getArray("fileUris");

        if (urisArray == null || urisArray.length() == 0) {
            JSObject empty = new JSObject();
            empty.put("succeeded", new JSArray());
            empty.put("failed", new JSArray());
            call.resolve(empty);
            return;
        }

        ioExecutor.execute(() -> {
            JSArray succeeded = new JSArray();
            JSArray failed = new JSArray();
            ContentResolver resolver = getContext().getContentResolver();

            Uri treeUri = resolveTreeUriWithFallback(folderId, urisArray);
            if (treeUri == null) {
                call.reject("Chybí oprávnění pro zápis do vybrané složky.");
                return;
            }

            String targetSubDocId;
            try {
                targetSubDocId = findOrCreateSubfolderDocId(resolver, treeUri, subfolderName);
            } catch (Exception e) {
                call.reject("Nelze vytvořit podsložku " + subfolderName + ": " + e.getMessage(), e);
                return;
            }

            Uri targetSubUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, targetSubDocId);
            String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri rootDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocId);

            boolean skipDuplicates = "liked".equalsIgnoreCase(subfolderName.trim());
            Set<String> existingLower = skipDuplicates
                ? readChildFileNamesLower(resolver, treeUri, targetSubDocId)
                : new HashSet<>();

            byte[] copyBuf = new byte[65536];

            for (int i = 0; i < urisArray.length(); i++) {
                String uriStr = "";
                try {
                    uriStr = urisArray.getString(i);
                    Uri srcUri = Uri.parse(uriStr);
                    String[] meta = queryNameAndMime(resolver, srcUri);
                    String fileName = meta[0];
                    String mimeType = meta[1];
                    String lowerKey = fileName.trim().toLowerCase(Locale.ROOT);

                    if (skipDuplicates && existingLower.contains(lowerKey)) {
                        succeeded.put(uriStr);
                        continue;
                    }

                    boolean movedAtomically = false;
                    if (deleteSourceAfter && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        try {
                            Uri parentUri = rootDocUri;
                            String srcDocId = DocumentsContract.getDocumentId(srcUri);
                            if (srcDocId != null) {
                                int slash = srcDocId.lastIndexOf('/');
                                if (slash > 0) {
                                    String parentDocId = srcDocId.substring(0, slash);
                                    parentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, parentDocId);
                                }
                            }
                            Uri movedUri = DocumentsContract.moveDocument(
                                resolver,
                                srcUri,
                                parentUri,
                                targetSubUri
                            );
                            if (movedUri != null) {
                                movedAtomically = true;
                            }
                        } catch (Exception ignored) {
                            movedAtomically = false;
                        }
                    }

                    if (!movedAtomically) {
                        Uri destUri = DocumentsContract.createDocument(
                            resolver,
                            targetSubUri,
                            mimeType,
                            fileName
                        );
                        if (destUri == null) {
                            throw new IllegalStateException("Nepodařilo se vytvořit cílový soubor.");
                        }
                        boolean copyOk = false;
                        try (InputStream in = resolver.openInputStream(srcUri);
                             OutputStream out = resolver.openOutputStream(destUri, "w")) {
                            if (in == null || out == null) {
                                throw new IllegalStateException("Nelze otevřít datový proud souboru.");
                            }
                            int read;
                            while ((read = in.read(copyBuf)) != -1) {
                                out.write(copyBuf, 0, read);
                            }
                            out.flush();
                            copyOk = true;
                        } finally {
                            if (!copyOk) {
                                try {
                                    DocumentsContract.deleteDocument(resolver, destUri);
                                } catch (Exception ignored) {
                                }
                            }
                        }

                        if (deleteSourceAfter) {
                            DocumentsContract.deleteDocument(resolver, srcUri);
                        }
                    }

                    existingLower.add(lowerKey);
                    succeeded.put(uriStr);
                } catch (Exception e) {
                    JSObject errObj = new JSObject();
                    errObj.put("uri", uriStr);
                    errObj.put("error", e.getMessage() != null ? e.getMessage() : "Chyba zápisu");
                    failed.put(errObj);
                }
            }

            JSObject ret = new JSObject();
            ret.put("succeeded", succeeded);
            ret.put("failed", failed);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void copyToSubfolder(PluginCall call) {
        executeSubfolderTransfer(call, false);
    }

    @PluginMethod
    public void moveToSubfolder(PluginCall call) {
        executeSubfolderTransfer(call, true);
    }

    @PluginMethod
    public void deleteFilesPermanently(PluginCall call) {
        final JSArray urisArray = call.getArray("fileUris");
        if (urisArray == null || urisArray.length() == 0) {
            JSObject empty = new JSObject();
            empty.put("succeeded", new JSArray());
            empty.put("failed", new JSArray());
            call.resolve(empty);
            return;
        }

        ioExecutor.execute(() -> {
            JSArray succeeded = new JSArray();
            JSArray failed = new JSArray();
            ContentResolver resolver = getContext().getContentResolver();

            for (int i = 0; i < urisArray.length(); i++) {
                String uriStr = "";
                try {
                    uriStr = urisArray.getString(i);
                    Uri uri = Uri.parse(uriStr);
                    boolean deleted = DocumentsContract.deleteDocument(resolver, uri);
                    if (deleted) {
                        succeeded.put(uriStr);
                    } else {
                        JSObject errObj = new JSObject();
                        errObj.put("uri", uriStr);
                        errObj.put("error", "Systém Android nepovolil smazání souboru.");
                        failed.put(errObj);
                    }
                } catch (Exception e) {
                    JSObject errObj = new JSObject();
                    errObj.put("uri", uriStr);
                    errObj.put("error", e.getMessage() != null ? e.getMessage() : "Chyba mazání");
                    failed.put(errObj);
                }
            }

            JSObject ret = new JSObject();
            ret.put("succeeded", succeeded);
            ret.put("failed", failed);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void triggerHaptic(PluginCall call) {
        String intensity = call.getString("intensity", "medium");
        long durationMs = 16L;
        int amplitude = 130;
        if ("light".equals(intensity)) {
            durationMs = 8L;
            amplitude = 75;
        } else if ("heavy".equals(intensity)) {
            durationMs = 26L;
            amplitude = 220;
        }

        try {
            Vibrator vibrator;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager vm = (VibratorManager) getContext().getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                vibrator = vm != null ? vm.getDefaultVibrator() : null;
            } else {
                vibrator = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (vibrator != null && vibrator.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createOneShot(durationMs, amplitude));
                } else {
                    vibrator.vibrate(durationMs);
                }
            }
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    private GoogleSignInClient buildGoogleClient(String webClientId, String loginHint) {
        GoogleSignInOptions.Builder builder = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestEmail()
            .requestScopes(new Scope(DRIVE_SCOPE));
        if (webClientId != null && !webClientId.trim().isEmpty()) {
            builder.requestIdToken(webClientId.trim());
        }
        if (loginHint != null && !loginHint.trim().isEmpty()) {
            builder.setAccountName(loginHint.trim());
        }
        return GoogleSignIn.getClient(getContext(), builder.build());
    }

    @PluginMethod
    public void googleSignIn(PluginCall call) {
        final String webClientId = call.getString("webClientId", "");
        final boolean forceAccountSelect = Boolean.TRUE.equals(call.getBoolean("forceAccountSelect", false));
        final String loginHint = forceAccountSelect ? null : call.getString("loginHint", null);

        final GoogleSignInClient client = buildGoogleClient(webClientId, loginHint);
        if (forceAccountSelect) {
            client.signOut().addOnCompleteListener(task -> {
                startActivityForResult(call, client.getSignInIntent(), "handleGoogleSignInResult");
            });
        } else {
            startActivityForResult(call, client.getSignInIntent(), "handleGoogleSignInResult");
        }
    }

    @ActivityCallback
    private void handleGoogleSignInResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Task<GoogleSignInAccount> task = GoogleSignIn.getSignedInAccountFromIntent(result.getData());
        try {
            final GoogleSignInAccount account = task.getResult(ApiException.class);
            if (account == null || account.getAccount() == null) {
                JSObject cancelled = new JSObject();
                cancelled.put("cancelled", true);
                call.resolve(cancelled);
                return;
            }
            fetchDriveTokenForAccount(call, account, true);
        } catch (ApiException e) {
            int code = e.getStatusCode();
            if (code == 12501 || result.getResultCode() == Activity.RESULT_CANCELED) {
                JSObject cancelled = new JSObject();
                cancelled.put("cancelled", true);
                call.resolve(cancelled);
                return;
            }
            if (code == 10) {
                call.reject(
                    "Pro přihlášení přes Google v APK přidejte otisk SHA-1 do Firebase Console " +
                    "(Nastavení projektu → Android aplikace com.selectra.app). Složky v telefonu fungují ihned."
                );
                return;
            }
            call.reject("Přihlášení přes Google se nezdařilo (kód " + code + ").", e);
        }
    }

    private void fetchDriveTokenForAccount(
        final PluginCall call,
        final GoogleSignInAccount account,
        final boolean allowInteractiveConsent
    ) {
        ioExecutor.execute(() -> {
            try {
                String token = GoogleAuthUtil.getToken(
                    getContext(),
                    account.getAccount(),
                    "oauth2:" + DRIVE_SCOPE
                );
                JSObject ret = new JSObject();
                ret.put("idToken", account.getIdToken() != null ? account.getIdToken() : "");
                ret.put("accessToken", token);
                ret.put("email", account.getEmail());
                call.resolve(ret);
            } catch (UserRecoverableAuthException recoverable) {
                Intent consentIntent = recoverable.getIntent();
                if (allowInteractiveConsent && consentIntent != null) {
                    pendingConsentAccount = account;
                    getActivity().runOnUiThread(() -> {
                        startActivityForResult(call, consentIntent, "handleDriveConsentResult");
                    });
                } else {
                    JSObject unavailable = new JSObject();
                    unavailable.put("available", false);
                    call.resolve(unavailable);
                }
            } catch (Exception e) {
                call.reject("Nepodařilo se získat přístupový token pro Google Drive: " + e.getMessage(), e);
            }
        });
    }

    @ActivityCallback
    private void handleDriveConsentResult(PluginCall call, ActivityResult result) {
        final GoogleSignInAccount account = pendingConsentAccount;
        pendingConsentAccount = null;
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || account == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        fetchDriveTokenForAccount(call, account, false);
    }

    @PluginMethod
    public void silentRefreshDriveToken(PluginCall call) {
        final String webClientId = call.getString("webClientId", "");
        final String invalidateToken = call.getString("invalidateToken", null);

        ioExecutor.execute(() -> {
            try {
                if (invalidateToken != null && !invalidateToken.isEmpty()) {
                    try {
                        GoogleAuthUtil.clearToken(getContext(), invalidateToken);
                    } catch (Exception ignored) {
                    }
                }

                GoogleSignInClient client = buildGoogleClient(webClientId, null);
                GoogleSignInAccount account = null;
                try {
                    account = Tasks.await(client.silentSignIn());
                } catch (Exception ignored) {
                    account = GoogleSignIn.getLastSignedInAccount(getContext());
                }

                if (account == null || account.getAccount() == null) {
                    JSObject ret = new JSObject();
                    ret.put("available", false);
                    call.resolve(ret);
                    return;
                }

                String token = GoogleAuthUtil.getToken(
                    getContext(),
                    account.getAccount(),
                    "oauth2:" + DRIVE_SCOPE
                );
                JSObject ret = new JSObject();
                ret.put("available", true);
                ret.put("idToken", account.getIdToken() != null ? account.getIdToken() : "");
                ret.put("accessToken", token);
                ret.put("email", account.getEmail());
                call.resolve(ret);
            } catch (Exception ignored) {
                JSObject ret = new JSObject();
                ret.put("available", false);
                call.resolve(ret);
            }
        });
    }

    @PluginMethod
    public void googleSignOut(PluginCall call) {
        GoogleSignInClient client = buildGoogleClient("", null);
        client.signOut().addOnCompleteListener(task -> call.resolve());
    }
}
`;

fs.writeFileSync(
  path.join(JAVA_PKG_DIR, 'SelectraNativePlugin.java'),
  pluginJava,
  'utf8'
);

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

  gradle = gradle.replace(/versionName\s+"[^"]*"/, 'versionName "2.14.0"');
  gradle = gradle.replace(/versionCode\s+\d+/, 'versionCode 214');

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

// 4. Patch AndroidManifest.xml (VIBRATE permission + largeHeap for RAW buffers)
const manifestPath = path.join(
  ANDROID_DIR,
  'app',
  'src',
  'main',
  'AndroidManifest.xml'
);
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  if (!manifest.includes('android:largeHeap=')) {
    manifest = manifest.replace(
      '<application',
      '<application\n        android:largeHeap="true"'
    );
  }
  if (!manifest.includes('android.permission.VIBRATE')) {
    manifest = manifest.replace(
      '</manifest>',
      '    <uses-permission android:name="android.permission.VIBRATE" />\n</manifest>'
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

// 6. Copy Selectra icons from public/pwa-512x512.png into mipmap launcher slots
const srcIcon512 = path.join(ROOT, 'public', 'pwa-512x512.png');
const srcIcon192 = path.join(ROOT, 'public', 'pwa-192x192.png');
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
    const fgIcon = fs.existsSync(srcMaskable) ? srcMaskable : srcIcon512;

    for (const fileName of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const p = path.join(targetDir, fileName);
      if (fs.existsSync(p)) fs.copyFileSync(baseIcon, p);
    }
    const fgPath = path.join(targetDir, 'ic_launcher_foreground.png');
    if (fs.existsSync(fgPath)) fs.copyFileSync(fgIcon, fgPath);
  }
}

console.log('Android projekt (SelectraNativePlugin + MainActivity + ikony) je připraven.');
