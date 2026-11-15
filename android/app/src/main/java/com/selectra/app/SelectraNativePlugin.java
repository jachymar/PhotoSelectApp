package com.selectra.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
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
import android.provider.Settings;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
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
    private String pendingSignInLoginHint = null;
    private boolean pendingSignInUsedWebClient = false;
    private volatile File pendingUpdateApkFile = null;

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

        pendingSignInLoginHint = loginHint;
        pendingSignInUsedWebClient = webClientId != null && !webClientId.trim().isEmpty();

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
            if (code == 10 && pendingSignInUsedWebClient) {
                pendingSignInUsedWebClient = false;
                GoogleSignInClient fallbackClient = buildGoogleClient("", pendingSignInLoginHint);
                startActivityForResult(call, fallbackClient.getSignInIntent(), "handleGoogleSignInResult");
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

    @PluginMethod
    public void getAppBuildInfo(PluginCall call) {
        try {
            Context ctx = getContext();
            PackageManager pm = ctx.getPackageManager();
            PackageInfo pInfo = pm.getPackageInfo(ctx.getPackageName(), 0);
            long vCode;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                vCode = pInfo.getLongVersionCode();
            } else {
                vCode = pInfo.versionCode;
            }
            boolean canInstall = true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                canInstall = pm.canRequestPackageInstalls();
            }
            JSObject ret = new JSObject();
            ret.put("versionName", pInfo.versionName != null ? pInfo.versionName : "");
            ret.put("versionCode", vCode);
            ret.put("packageName", ctx.getPackageName());
            ret.put("canInstallPackages", canInstall);
            ret.put("hasPendingApk", pendingUpdateApkFile != null && pendingUpdateApkFile.exists());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Nepodařilo se načíst informace o verzi aplikace: " + e.getMessage(), e);
        }
    }

    private void launchApkInstaller(File apkFile) {
        Context ctx = getContext();
        Uri contentUri = FileProvider.getUriForFile(
            ctx,
            ctx.getPackageName() + ".fileprovider",
            apkFile
        );
        Intent installIntent = new Intent(Intent.ACTION_VIEW);
        installIntent.setDataAndType(contentUri, "application/vnd.android.package-archive");
        installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(installIntent);
    }

    private void openUnknownSourcesSettings() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Context ctx = getContext();
            Intent settingsIntent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + ctx.getPackageName())
            );
            settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(settingsIntent);
        }
    }

    @PluginMethod
    public void downloadAndInstallApk(PluginCall call) {
        final String apkUrl = call.getString("apkUrl", "");
        final String githubToken = call.getString("githubToken", null);
        if (apkUrl == null || apkUrl.trim().isEmpty()) {
            call.reject("Chybí adresa instalačního balíčku APK.");
            return;
        }

        ioExecutor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                File updatesDir = new File(getContext().getCacheDir(), "updates");
                if (!updatesDir.exists()) {
                    updatesDir.mkdirs();
                }
                File[] existing = updatesDir.listFiles();
                if (existing != null) {
                    for (File f : existing) {
                        f.delete();
                    }
                }

                File tempFile = new File(updatesDir, "Selectra-download.apk.part");
                File finalApkFile = new File(updatesDir, "Selectra-update.apk");

                String currentUrlStr = apkUrl.trim();
                int redirects = 0;
                while (true) {
                    URL urlObj = new URL(currentUrlStr);
                    conn = (HttpURLConnection) urlObj.openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(60000);
                    conn.setRequestProperty("User-Agent", "Selectra-Android-Updater");

                    String host = urlObj.getHost() != null ? urlObj.getHost().toLowerCase(Locale.ROOT) : "";
                    if (githubToken != null && !githubToken.trim().isEmpty() && host.endsWith("github.com")) {
                        conn.setRequestProperty("Authorization", "Bearer " + githubToken.trim());
                        if (host.equals("api.github.com")) {
                            conn.setRequestProperty("Accept", "application/octet-stream");
                        }
                    }

                    int status = conn.getResponseCode();
                    if (status == HttpURLConnection.HTTP_MOVED_TEMP
                        || status == HttpURLConnection.HTTP_MOVED_PERM
                        || status == HttpURLConnection.HTTP_SEE_OTHER
                        || status == 307
                        || status == 308) {
                        String location = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (location == null || location.isEmpty() || redirects >= 6) {
                            throw new Exception("Neplatné přesměrování při stahování APK.");
                        }
                        currentUrlStr = new URL(urlObj, location).toString();
                        redirects++;
                        continue;
                    }

                    if (status < 200 || status >= 300) {
                        conn.disconnect();
                        throw new Exception("Server vrátil chybu HTTP " + status + " při stahování APK.");
                    }
                    break;
                }

                long totalBytes = conn.getContentLengthLong();
                long downloaded = 0L;
                long lastNotifyMs = 0L;

                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(tempFile)) {
                    byte[] buffer = new byte[32768];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        downloaded += read;
                        long now = System.currentTimeMillis();
                        if (now - lastNotifyMs >= 120L) {
                            lastNotifyMs = now;
                            int pct = totalBytes > 0
                                ? (int) Math.min(99L, (downloaded * 100L) / totalBytes)
                                : 50;
                            JSObject prog = new JSObject();
                            prog.put("downloadedBytes", downloaded);
                            prog.put("totalBytes", totalBytes > 0 ? totalBytes : downloaded);
                            prog.put("percent", pct);
                            notifyListeners("apkDownloadProgress", prog);
                        }
                    }
                    out.flush();
                } finally {
                    conn.disconnect();
                }

                if (tempFile.length() < 65536L) {
                    tempFile.delete();
                    call.reject("Stažený soubor je neúplný nebo poškozený.");
                    return;
                }

                byte[] magic = new byte[2];
                try (FileInputStream checkIn = new FileInputStream(tempFile)) {
                    if (checkIn.read(magic) != 2 || magic[0] != 0x50 || magic[1] != 0x4B) {
                        tempFile.delete();
                        call.reject("Stažený soubor není platný balíček Android APK.");
                        return;
                    }
                }

                if (finalApkFile.exists()) {
                    finalApkFile.delete();
                }
                if (!tempFile.renameTo(finalApkFile)) {
                    finalApkFile = tempFile;
                }

                pendingUpdateApkFile = finalApkFile;
                JSObject doneProg = new JSObject();
                doneProg.put("downloadedBytes", downloaded);
                doneProg.put("totalBytes", downloaded);
                doneProg.put("percent", 100);
                notifyListeners("apkDownloadProgress", doneProg);

                final File readyApk = finalApkFile;
                getActivity().runOnUiThread(() -> {
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                            && !getContext().getPackageManager().canRequestPackageInstalls()) {
                            openUnknownSourcesSettings();
                            JSObject ret = new JSObject();
                            ret.put("status", "needs_install_permission");
                            call.resolve(ret);
                            return;
                        }
                        launchApkInstaller(readyApk);
                        JSObject ret = new JSObject();
                        ret.put("status", "installer_launched");
                        call.resolve(ret);
                    } catch (Exception uiErr) {
                        call.reject("Nepodařilo se spustit instalaci aktualizace: " + uiErr.getMessage(), uiErr);
                    }
                });
            } catch (Exception e) {
                call.reject("Chyba při stahování aktualizace: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void installPendingApk(PluginCall call) {
        final File readyApk = pendingUpdateApkFile;
        if (readyApk == null || !readyApk.exists()) {
            call.reject("Žádný stažený balíček aktualizace není připraven v mezipaměti.");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !getContext().getPackageManager().canRequestPackageInstalls()) {
                    openUnknownSourcesSettings();
                    JSObject ret = new JSObject();
                    ret.put("status", "needs_install_permission");
                    call.resolve(ret);
                    return;
                }
                launchApkInstaller(readyApk);
                JSObject ret = new JSObject();
                ret.put("status", "installer_launched");
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Nepodařilo se otevřít instalátor APK: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        final String url = call.getString("url", "");
        if (url == null || url.trim().isEmpty()) {
            call.reject("Chybí URL adresa.");
            return;
        }
        try {
            Intent viewIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(url.trim()));
            viewIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(viewIntent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Nepodařilo se otevřít odkaz v prohlížeči: " + e.getMessage(), e);
        }
    }
}
