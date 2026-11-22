package com.selectra.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.graphics.Point;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.exifinterface.media.ExifInterface;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
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
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "SelectraNative",
    permissions = {
        @Permission(
            alias = "legacyStorage",
            strings = {
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.WRITE_EXTERNAL_STORAGE
            }
        )
    }
)
public class SelectraNativePlugin extends Plugin {

    private static final String PREFS_SAF = "selectra_saf_trees_v1";
    private static final String PREFS_FS = "selectra_fs_folders_v1";
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
    private final ExecutorService thumbExecutor = Executors.newFixedThreadPool(3);
    private GoogleSignInAccount pendingConsentAccount = null;
    private String pendingSignInLoginHint = null;
    private boolean pendingSignInUsedWebClient = false;
    private volatile File pendingUpdateApkFile = null;

    private String computeFolderId(Uri treeUri) {
        int hash = treeUri.toString().hashCode();
        return "saf-tree-" + Integer.toUnsignedString(hash, 36);
    }

    private String computeSafSubfolderId(Uri treeUri, String docId) {
        String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
        if (docId == null || docId.isEmpty() || docId.equals(rootDocId)) {
            return computeFolderId(treeUri);
        }
        int hash = (treeUri.toString() + "::" + docId).hashCode();
        return "saf-sub-" + Integer.toUnsignedString(hash, 36);
    }

    private String computeFsFolderId(String canonicalPath) {
        int hash = canonicalPath.hashCode();
        return "fs-" + Integer.toUnsignedString(hash, 36);
    }

    private static boolean isFileSchemeUri(String uriStr) {
        if (uriStr == null) return false;
        return uriStr.startsWith("file://") || uriStr.startsWith("/");
    }

    private static File resolveFileFromUri(String uriStr) {
        if (uriStr == null || uriStr.isEmpty()) return null;
        if (uriStr.startsWith("/")) {
            return new File(uriStr);
        }
        if (uriStr.startsWith("file://")) {
            Uri parsed = Uri.parse(uriStr);
            String p = parsed.getPath();
            if (p != null && !p.isEmpty()) {
                return new File(p);
            }
        }
        return null;
    }

    private static String guessMimeTypeForFileName(String name) {
        String ext = getExtensionLower(name);
        if (ext.isEmpty()) return "application/octet-stream";
        String mapped = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (mapped != null && !mapped.isEmpty()) return mapped;
        if ("jpg".equals(ext) || "jpeg".equals(ext)) return "image/jpeg";
        if ("png".equals(ext)) return "image/png";
        if ("webp".equals(ext)) return "image/webp";
        if ("heic".equals(ext) || "heif".equals(ext)) return "image/heic";
        return "application/octet-stream";
    }

    private boolean hasAllFilesPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return Environment.isExternalStorageManager();
        }
        return ContextCompat.checkSelfPermission(
            getContext(),
            Manifest.permission.READ_EXTERNAL_STORAGE
        ) == PackageManager.PERMISSION_GRANTED;
    }

    private void savePersistedFsFolder(String folderId, String folderName, String canonicalPath) {
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS_FS, Context.MODE_PRIVATE);
            JSONObject obj = new JSONObject();
            obj.put("folderId", folderId);
            obj.put("folderName", folderName);
            obj.put("path", canonicalPath);
            obj.put("updatedAtMs", System.currentTimeMillis());
            prefs.edit().putString(folderId, obj.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private String getPersistedFsPath(String folderId) {
        if (folderId == null || folderId.isEmpty()) return null;
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS_FS, Context.MODE_PRIVATE);
            String raw = prefs.getString(folderId, null);
            if (raw == null) return null;
            JSONObject obj = new JSONObject(raw);
            String path = obj.optString("path", "");
            return path.isEmpty() ? null : path;
        } catch (Exception e) {
            return null;
        }
    }

    private String extractDocumentDisplayName(ContentResolver resolver, Uri treeUri, String docId, String fallback) {
        try {
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
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
            if (docId != null) {
                int slash = docId.lastIndexOf('/');
                if (slash >= 0 && slash + 1 < docId.length()) {
                    return docId.substring(slash + 1);
                }
                int colon = docId.lastIndexOf(':');
                if (colon >= 0 && colon + 1 < docId.length()) {
                    return docId.substring(colon + 1);
                }
            }
        } catch (Exception ignored) {
        }
        return (fallback != null && !fallback.isEmpty()) ? fallback : "Lokální složka";
    }

    private String extractFolderDisplayName(ContentResolver resolver, Uri treeUri) {
        String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
        return extractDocumentDisplayName(resolver, treeUri, rootDocId, "Lokální složka");
    }

    private void savePersistedTree(String folderId, String folderName, Uri treeUri) {
        savePersistedSafEntry(folderId, folderName, treeUri, DocumentsContract.getTreeDocumentId(treeUri), true, true);
    }

    private void savePersistedSafEntry(
        String folderId,
        String folderName,
        Uri treeUri,
        String docId,
        boolean markAsRoot
    ) {
        savePersistedSafEntry(folderId, folderName, treeUri, docId, markAsRoot, true);
    }

    private void savePersistedSafEntry(
        String folderId,
        String folderName,
        Uri treeUri,
        String docId,
        boolean markAsRoot,
        boolean markOpenedForCulling
    ) {
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS_SAF, Context.MODE_PRIVATE);
            boolean keepRoot = markAsRoot;
            boolean keepCulled = markOpenedForCulling;
            String existingRaw = prefs.getString(folderId, null);
            if (existingRaw != null) {
                try {
                    JSONObject prev = new JSONObject(existingRaw);
                    if (!keepRoot && prev.optBoolean("isRoot", false)) {
                        keepRoot = true;
                    }
                    if (!keepCulled && prev.optBoolean("openedForCulling", true)) {
                        keepCulled = true;
                    }
                } catch (Exception ignored) {
                }
            }
            JSONObject obj = new JSONObject();
            obj.put("folderId", folderId);
            obj.put("folderName", folderName);
            obj.put("treeUri", treeUri.toString());
            if (docId != null && !docId.isEmpty()) {
                obj.put("docId", docId);
            }
            obj.put("isRoot", keepRoot);
            obj.put("openedForCulling", keepCulled);
            obj.put("updatedAtMs", System.currentTimeMillis());
            prefs.edit().putString(folderId, obj.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private JSONObject getPersistedSafRecord(String folderId) {
        if (folderId == null || folderId.isEmpty()) return null;
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS_SAF, Context.MODE_PRIVATE);
            String raw = prefs.getString(folderId, null);
            if (raw == null) return null;
            return new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    private Uri getPersistedTreeUri(String folderId) {
        JSONObject obj = getPersistedSafRecord(folderId);
        if (obj == null) return null;
        String uriStr = obj.optString("treeUri", "");
        if (uriStr.isEmpty()) return null;
        return Uri.parse(uriStr);
    }

    private String getPersistedSafDocId(String folderId, Uri treeUri) {
        JSONObject obj = getPersistedSafRecord(folderId);
        if (obj != null) {
            String stored = obj.optString("docId", "");
            if (!stored.isEmpty()) return stored;
        }
        return DocumentsContract.getTreeDocumentId(treeUri);
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

    private void scanFileDirectoryRecursive(
        File dir,
        String folderId,
        String relativePrefix,
        int depth,
        JSArray outFiles
    ) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (child == null) continue;
            String name = child.getName();
            if (name == null || name.isEmpty() || name.startsWith(".")) continue;
            if (child.isDirectory()) {
                if (depth < 2 && child.canRead()) {
                    String lower = name.trim().toLowerCase(Locale.ROOT);
                    if (!IGNORED_DIRS.contains(lower)) {
                        String nextPrefix = relativePrefix.isEmpty()
                            ? name
                            : (relativePrefix + "/" + name);
                        scanFileDirectoryRecursive(child, folderId, nextPrefix, depth + 1, outFiles);
                    }
                }
            } else if (child.isFile()) {
                String mime = guessMimeTypeForFileName(name);
                if (!isSupportedPhotoEntry(name, mime)) continue;
                String relPath = relativePrefix.isEmpty()
                    ? name
                    : (relativePrefix + "/" + name);
                JSObject item = new JSObject();
                item.put("id", "fs:" + folderId + ":" + relPath);
                item.put("uri", Uri.fromFile(child).toString());
                item.put("name", name);
                item.put("relativePath", relPath);
                item.put("mimeType", mime);
                item.put("sizeBytes", child.length());
                item.put("lastModifiedMs", child.lastModified());
                outFiles.put(item);
            }
        }
    }

    @PluginMethod
    public void getStoragePermissionStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasAllFilesPermission());
        ret.put("apiLevel", Build.VERSION.SDK_INT);
        ret.put("requiresAllFilesSettings", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        if (hasAllFilesPermission()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                Intent intent = new Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                startActivityForResult(call, intent, "handleAllFilesPermissionResult");
            } catch (Exception e) {
                try {
                    Intent fallback = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                    startActivityForResult(call, fallback, "handleAllFilesPermissionResult");
                } catch (Exception ex) {
                    try {
                        Intent appDetails = new Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getContext().getPackageName())
                        );
                        startActivityForResult(call, appDetails, "handleAllFilesPermissionResult");
                    } catch (Exception ex2) {
                        call.reject("Nepodařilo se otevřít nastavení oprávnění k souborům: " + ex2.getMessage(), ex2);
                    }
                }
            }
            return;
        }
        requestPermissionForAlias("legacyStorage", call, "handleLegacyStoragePermResult");
    }

    @ActivityCallback
    private void handleAllFilesPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject ret = new JSObject();
        ret.put("granted", hasAllFilesPermission());
        call.resolve(ret);
    }

    @PermissionCallback
    private void handleLegacyStoragePermResult(PluginCall call) {
        if (call == null) return;
        JSObject ret = new JSObject();
        ret.put("granted", hasAllFilesPermission());
        call.resolve(ret);
    }

    @PluginMethod
    public void listStorageRoots(PluginCall call) {
        ioExecutor.execute(() -> {
            JSArray roots = new JSArray();
            JSArray shortcuts = new JSArray();
            boolean granted = hasAllFilesPermission();
            Set<String> seenPaths = new HashSet<>();

            if (granted) {
                File primaryDir = Environment.getExternalStorageDirectory();
                if (primaryDir != null && primaryDir.exists() && primaryDir.isDirectory()) {
                    String primaryPath;
                    try {
                        primaryPath = primaryDir.getCanonicalPath();
                    } catch (Exception e) {
                        primaryPath = primaryDir.getAbsolutePath();
                    }
                    seenPaths.add(primaryPath);

                    JSObject internalRoot = new JSObject();
                    internalRoot.put("id", "root-internal");
                    internalRoot.put("kind", "file");
                    internalRoot.put("name", "Interní úložiště");
                    internalRoot.put("path", primaryPath);
                    internalRoot.put("volumeType", "internal");
                    roots.put(internalRoot);

                    String[][] quickDefs = new String[][] {
                        { "DCIM", "DCIM", "dcim" },
                        { "Pictures", "Pictures", "pictures" },
                        { "Download", "Download", "download" },
                        { "Documents", "Documents", "documents" }
                    };
                    for (String[] def : quickDefs) {
                        File qDir = new File(primaryDir, def[0]);
                        if (qDir.exists() && qDir.isDirectory() && qDir.canRead()) {
                            String qPath;
                            try {
                                qPath = qDir.getCanonicalPath();
                            } catch (Exception e) {
                                qPath = qDir.getAbsolutePath();
                            }
                            JSObject sc = new JSObject();
                            sc.put("id", "shortcut-" + def[2]);
                            sc.put("kind", "file");
                            sc.put("name", def[1]);
                            sc.put("path", qPath);
                            sc.put("volumeType", "shortcut");
                            sc.put("shortcutKey", def[2]);
                            shortcuts.put(sc);
                        }
                    }
                }

                // Discover removable SD cards & mounted USB volumes via StorageManager (API 30+)
                try {
                    StorageManager sm = (StorageManager) getContext().getSystemService(Context.STORAGE_SERVICE);
                    if (sm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        List<StorageVolume> volumes = sm.getStorageVolumes();
                        for (StorageVolume vol : volumes) {
                            if (vol == null || vol.isPrimary()) continue;
                            if (!Environment.MEDIA_MOUNTED.equals(vol.getState()) &&
                                !Environment.MEDIA_MOUNTED_READ_ONLY.equals(vol.getState())) {
                                continue;
                            }
                            File dir = vol.getDirectory();
                            if (dir == null || !dir.exists() || !dir.isDirectory() || !dir.canRead()) {
                                continue;
                            }
                            String volPath;
                            try {
                                volPath = dir.getCanonicalPath();
                            } catch (Exception e) {
                                volPath = dir.getAbsolutePath();
                            }
                            if (seenPaths.contains(volPath)) continue;
                            seenPaths.add(volPath);

                            String desc = vol.getDescription(getContext());
                            if (desc == null || desc.trim().isEmpty()) {
                                desc = dir.getName();
                            }
                            String lowerDesc = desc.toLowerCase(Locale.ROOT);
                            String vType = lowerDesc.contains("usb") ? "usb" : "sd";

                            JSObject extRoot = new JSObject();
                            extRoot.put("id", "root-vol-" + Integer.toUnsignedString(volPath.hashCode(), 36));
                            extRoot.put("kind", "file");
                            extRoot.put("name", desc.trim());
                            extRoot.put("path", volPath);
                            extRoot.put("volumeType", vType);
                            roots.put(extRoot);
                        }
                    }
                } catch (Exception ignored) {
                }

                // Fallback scan of /storage/* for additional removable cards/USB sticks
                try {
                    File storageRoot = new File("/storage");
                    File[] mounted = storageRoot.listFiles();
                    if (mounted != null) {
                        for (File volDir : mounted) {
                            if (volDir == null || !volDir.isDirectory() || !volDir.canRead()) continue;
                            String name = volDir.getName();
                            if (name == null || name.isEmpty()
                                || "emulated".equalsIgnoreCase(name)
                                || "self".equalsIgnoreCase(name)
                                || "enc_emulated".equalsIgnoreCase(name)) {
                                continue;
                            }
                            String volPath;
                            try {
                                volPath = volDir.getCanonicalPath();
                            } catch (Exception e) {
                                volPath = volDir.getAbsolutePath();
                            }
                            if (seenPaths.contains(volPath)) continue;
                            seenPaths.add(volPath);

                            JSObject extRoot = new JSObject();
                            extRoot.put("id", "root-vol-" + Integer.toUnsignedString(volPath.hashCode(), 36));
                            extRoot.put("kind", "file");
                            extRoot.put("name", "SD / USB (" + name + ")");
                            extRoot.put("path", volPath);
                            extRoot.put("volumeType", "sd");
                            roots.put(extRoot);
                        }
                    }
                } catch (Exception ignored) {
                }
            }

            // Include persisted SAF roots (e.g. attached USB-C OTG readers or manually mounted trees)
            try {
                ContentResolver resolver = getContext().getContentResolver();
                SharedPreferences prefs = getContext().getSharedPreferences(PREFS_SAF, Context.MODE_PRIVATE);
                Map<String, ?> all = prefs.getAll();
                Set<String> seenTrees = new HashSet<>();
                for (Map.Entry<String, ?> entry : all.entrySet()) {
                    Object rawVal = entry.getValue();
                    if (!(rawVal instanceof String)) continue;
                    try {
                        JSONObject obj = new JSONObject((String) rawVal);
                        String uriStr = obj.optString("treeUri", "");
                        if (uriStr.isEmpty() || seenTrees.contains(uriStr)) continue;
                        boolean isRoot = obj.optBoolean("isRoot", true);
                        String id = obj.optString("folderId", entry.getKey());
                        if (!isRoot || id.startsWith("saf-sub-")) continue;

                        Uri treeUri = Uri.parse(uriStr);
                        if (!hasValidPersistedPermission(resolver, treeUri)) continue;
                        seenTrees.add(uriStr);

                        String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
                        String name = obj.optString("folderName", "Externí úložiště");
                        JSObject safRoot = new JSObject();
                        safRoot.put("id", id);
                        safRoot.put("kind", "saf");
                        safRoot.put("treeId", id);
                        safRoot.put("docId", rootDocId);
                        safRoot.put("name", name);
                        safRoot.put("volumeType", "saf");
                        roots.put(safRoot);
                    } catch (Exception ignored) {
                    }
                }
            } catch (Exception ignored) {
            }

            JSObject ret = new JSObject();
            ret.put("hasAllFilesAccess", granted);
            ret.put("roots", roots);
            ret.put("shortcuts", shortcuts);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void attachSafRoot(PluginCall call) {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION |
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
            );
            startActivityForResult(call, intent, "handleAttachSafRootResult");
        } catch (Exception e) {
            call.reject("Nepodařilo se otevřít výběr externího úložiště: " + e.getMessage(), e);
        }
    }

    @ActivityCallback
    private void handleAttachSafRootResult(PluginCall call, ActivityResult result) {
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
                String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
                savePersistedSafEntry(folderId, folderName, treeUri, rootDocId, true, false);

                JSObject root = new JSObject();
                root.put("id", folderId);
                root.put("kind", "saf");
                root.put("treeId", folderId);
                root.put("docId", rootDocId);
                root.put("name", folderName);
                root.put("volumeType", "saf");

                JSObject ret = new JSObject();
                ret.put("cancelled", false);
                ret.put("root", root);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Nepodařilo se připojit externí složku: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void removeSafRoot(PluginCall call) {
        final String treeId = call.getString("treeId", "");
        if (treeId != null && !treeId.isEmpty()) {
            try {
                Uri treeUri = getPersistedTreeUri(treeId);
                SharedPreferences prefs = getContext().getSharedPreferences(PREFS_SAF, Context.MODE_PRIVATE);
                SharedPreferences.Editor ed = prefs.edit();
                ed.remove(treeId);
                if (treeUri != null) {
                    String uriStr = treeUri.toString();
                    Map<String, ?> all = prefs.getAll();
                    for (Map.Entry<String, ?> e : all.entrySet()) {
                        if (!(e.getValue() instanceof String)) continue;
                        try {
                            JSONObject obj = new JSONObject((String) e.getValue());
                            if (uriStr.equals(obj.optString("treeUri", ""))) {
                                ed.remove(e.getKey());
                            }
                        } catch (Exception ignored) {
                        }
                    }
                    try {
                        getContext().getContentResolver().releasePersistableUriPermission(
                            treeUri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        );
                    } catch (Exception ignored) {
                    }
                }
                ed.apply();
            } catch (Exception ignored) {
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void listLocalDirectory(PluginCall call) {
        final String kind = call.getString("kind", "file");
        final String pathArg = call.getString("path", "");
        final String treeId = call.getString("treeId", "");
        final String docIdArg = call.getString("docId", "");

        ioExecutor.execute(() -> {
            try {
                if ("saf".equals(kind)) {
                    ContentResolver resolver = getContext().getContentResolver();
                    Uri treeUri = getPersistedTreeUri(treeId);
                    if (treeUri == null || !hasValidPersistedPermission(resolver, treeUri)) {
                        call.reject("Připojené externí úložiště již není dostupné.");
                        return;
                    }
                    String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
                    String targetDocId = (docIdArg != null && !docIdArg.isEmpty()) ? docIdArg : rootDocId;
                    String folderId = computeSafSubfolderId(treeUri, targetDocId);
                    String displayName = extractDocumentDisplayName(resolver, treeUri, targetDocId, "Externí složka");

                    Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, targetDocId);
                    List<JSObject> subList = new ArrayList<>();
                    List<JSObject> photoList = new ArrayList<>();

                    try (Cursor c = resolver.query(childrenUri, DOC_PROJECTION, null, null, null)) {
                        if (c != null) {
                            while (c.moveToNext()) {
                                String docId = c.getString(0);
                                String name = c.isNull(1) ? "" : c.getString(1);
                                String mime = c.isNull(2) ? "" : c.getString(2);
                                long size = c.isNull(3) ? 0L : c.getLong(3);
                                long lastMod = c.isNull(4) ? 0L : c.getLong(4);
                                if (docId == null || name == null || name.isEmpty() || name.startsWith(".")) continue;

                                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                                    String lower = name.trim().toLowerCase(Locale.ROOT);
                                    if (IGNORED_DIRS.contains(lower)) continue;
                                    JSObject sub = new JSObject();
                                    sub.put("id", computeSafSubfolderId(treeUri, docId));
                                    sub.put("name", name);
                                    sub.put("treeId", treeId);
                                    sub.put("docId", docId);
                                    sub.put("lastModifiedMs", lastMod);
                                    subList.add(sub);
                                } else {
                                    if (!isSupportedPhotoEntry(name, mime)) continue;
                                    Uri fileUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
                                    JSObject item = new JSObject();
                                    item.put("id", "saf:" + folderId + ":" + docId);
                                    item.put("uri", fileUri.toString());
                                    item.put("name", name);
                                    item.put("relativePath", name);
                                    item.put("mimeType", mime);
                                    item.put("sizeBytes", size);
                                    item.put("lastModifiedMs", lastMod);
                                    photoList.add(item);
                                }
                            }
                        }
                    }

                    Collections.sort(subList, (a, b) ->
                        a.optString("name", "").compareToIgnoreCase(b.optString("name", ""))
                    );
                    Collections.sort(photoList, (a, b) -> {
                        long ta = a.optLong("lastModifiedMs", 0L);
                        long tb = b.optLong("lastModifiedMs", 0L);
                        if (ta > 0 && tb > 0 && Math.abs(ta - tb) > 4000L) {
                            return Long.compare(tb, ta);
                        }
                        return a.optString("name", "").compareToIgnoreCase(b.optString("name", ""));
                    });

                    JSArray subfoldersArr = new JSArray();
                    for (JSObject s : subList) subfoldersArr.put(s);
                    JSArray photosArr = new JSArray();
                    for (JSObject p : photoList) photosArr.put(p);

                    JSObject ret = new JSObject();
                    ret.put("folderId", folderId);
                    ret.put("name", displayName);
                    ret.put("kind", "saf");
                    ret.put("treeId", treeId);
                    ret.put("docId", targetDocId);
                    ret.put("canGoUp", !targetDocId.equals(rootDocId));
                    ret.put("subfolders", subfoldersArr);
                    ret.put("photos", photosArr);
                    call.resolve(ret);
                    return;
                }

                // Direct filesystem listing
                if (!hasAllFilesPermission()) {
                    call.reject("Chybí oprávnění pro přístup k souborům v úložišti.");
                    return;
                }
                File dir = (pathArg != null && !pathArg.isEmpty())
                    ? new File(pathArg)
                    : Environment.getExternalStorageDirectory();
                if (dir == null || !dir.exists() || !dir.isDirectory()) {
                    call.reject("Složka v úložišti nebyla nalezena.");
                    return;
                }
                String canonicalPath;
                try {
                    canonicalPath = dir.getCanonicalPath();
                } catch (Exception e) {
                    canonicalPath = dir.getAbsolutePath();
                }
                String folderId = computeFsFolderId(canonicalPath);
                File[] children = dir.listFiles();

                List<JSObject> subList = new ArrayList<>();
                List<JSObject> photoList = new ArrayList<>();

                if (children != null) {
                    boolean fastCountMode = children.length <= 80;
                    for (File child : children) {
                        if (child == null) continue;
                        String name = child.getName();
                        if (name == null || name.isEmpty() || name.startsWith(".")) continue;
                        if (child.isDirectory()) {
                            if (!child.canRead()) continue;
                            String lower = name.trim().toLowerCase(Locale.ROOT);
                            if (IGNORED_DIRS.contains(lower)) continue;
                            String childCanonical;
                            try {
                                childCanonical = child.getCanonicalPath();
                            } catch (Exception e) {
                                childCanonical = child.getAbsolutePath();
                            }

                            int directPhotos = 0;
                            int directSubdirs = 0;
                            if (fastCountMode) {
                                File[] grand = child.listFiles();
                                if (grand != null) {
                                    int cap = Math.min(grand.length, 2500);
                                    for (int i = 0; i < cap; i++) {
                                        File g = grand[i];
                                        if (g == null) continue;
                                        String gn = g.getName();
                                        if (gn == null || gn.isEmpty() || gn.startsWith(".")) continue;
                                        if (g.isDirectory()) {
                                            if (!IGNORED_DIRS.contains(gn.trim().toLowerCase(Locale.ROOT))) {
                                                directSubdirs++;
                                            }
                                        } else if (isSupportedPhotoEntry(gn, null)) {
                                            directPhotos++;
                                        }
                                    }
                                }
                            }

                            JSObject sub = new JSObject();
                            sub.put("id", computeFsFolderId(childCanonical));
                            sub.put("name", name);
                            sub.put("path", childCanonical);
                            sub.put("lastModifiedMs", child.lastModified());
                            if (fastCountMode) {
                                sub.put("photoCount", directPhotos);
                                sub.put("subfolderCount", directSubdirs);
                            }
                            subList.add(sub);
                        } else if (child.isFile()) {
                            String mime = guessMimeTypeForFileName(name);
                            if (!isSupportedPhotoEntry(name, mime)) continue;
                            JSObject item = new JSObject();
                            item.put("id", "fs:" + folderId + ":" + name);
                            item.put("uri", Uri.fromFile(child).toString());
                            item.put("name", name);
                            item.put("relativePath", name);
                            item.put("mimeType", mime);
                            item.put("sizeBytes", child.length());
                            item.put("lastModifiedMs", child.lastModified());
                            photoList.add(item);
                        }
                    }
                }

                Collections.sort(subList, (a, b) ->
                    a.optString("name", "").compareToIgnoreCase(b.optString("name", ""))
                );
                Collections.sort(photoList, (a, b) -> {
                    long ta = a.optLong("lastModifiedMs", 0L);
                    long tb = b.optLong("lastModifiedMs", 0L);
                    if (ta > 0 && tb > 0 && Math.abs(ta - tb) > 4000L) {
                        return Long.compare(tb, ta);
                    }
                    return a.optString("name", "").compareToIgnoreCase(b.optString("name", ""));
                });

                JSArray subfoldersArr = new JSArray();
                for (JSObject s : subList) subfoldersArr.put(s);
                JSArray photosArr = new JSArray();
                for (JSObject p : photoList) photosArr.put(p);

                File parent = dir.getParentFile();
                boolean canGoUp = parent != null && parent.canRead()
                    && !"/storage".equals(parent.getAbsolutePath())
                    && !"/storage/emulated".equals(parent.getAbsolutePath())
                    && !"/".equals(canonicalPath);

                String displayName = dir.getName();
                File primaryDir = Environment.getExternalStorageDirectory();
                if (primaryDir != null) {
                    try {
                        if (primaryDir.getCanonicalPath().equals(canonicalPath)) {
                            displayName = "Interní úložiště";
                            canGoUp = false;
                        }
                    } catch (Exception ignored) {
                    }
                }
                if (displayName == null || displayName.isEmpty()) {
                    displayName = "Lokální úložiště";
                }

                JSObject ret = new JSObject();
                ret.put("folderId", folderId);
                ret.put("name", displayName);
                ret.put("kind", "file");
                ret.put("path", canonicalPath);
                if (canGoUp && parent != null) {
                    try {
                        ret.put("parentPath", parent.getCanonicalPath());
                    } catch (Exception e) {
                        ret.put("parentPath", parent.getAbsolutePath());
                    }
                }
                ret.put("canGoUp", canGoUp);
                ret.put("subfolders", subfoldersArr);
                ret.put("photos", photosArr);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Nepodařilo se načíst obsah složky: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void openLocalDirectory(PluginCall call) {
        final String kind = call.getString("kind", "file");
        final String pathArg = call.getString("path", "");
        final String treeId = call.getString("treeId", "");
        final String docIdArg = call.getString("docId", "");
        final String customName = call.getString("folderName", "");

        ioExecutor.execute(() -> {
            try {
                if ("saf".equals(kind)) {
                    ContentResolver resolver = getContext().getContentResolver();
                    Uri treeUri = getPersistedTreeUri(treeId);
                    if (treeUri == null || !hasValidPersistedPermission(resolver, treeUri)) {
                        call.reject("Oprávnění k externímu úložišti vypršelo.");
                        return;
                    }
                    String rootDocId = DocumentsContract.getTreeDocumentId(treeUri);
                    String targetDocId = (docIdArg != null && !docIdArg.isEmpty()) ? docIdArg : rootDocId;
                    String folderId = computeSafSubfolderId(treeUri, targetDocId);
                    String folderName = (customName != null && !customName.trim().isEmpty())
                        ? customName.trim()
                        : extractDocumentDisplayName(resolver, treeUri, targetDocId, "Lokální složka");

                    savePersistedSafEntry(folderId, folderName, treeUri, targetDocId, targetDocId.equals(rootDocId));

                    JSArray files = new JSArray();
                    scanDirectoryRecursive(resolver, treeUri, folderId, targetDocId, "", 0, files);

                    JSObject ret = new JSObject();
                    ret.put("folderId", folderId);
                    ret.put("folderName", folderName);
                    ret.put("files", files);
                    call.resolve(ret);
                    return;
                }

                if (!hasAllFilesPermission()) {
                    call.reject("Chybí oprávnění pro přístup ke všem souborům.");
                    return;
                }
                if (pathArg == null || pathArg.isEmpty()) {
                    call.reject("Chybí cesta ke složce.");
                    return;
                }
                File dir = new File(pathArg);
                if (!dir.exists() || !dir.isDirectory()) {
                    call.reject("Vybraná složka nebyla nalezena.");
                    return;
                }
                String canonicalPath;
                try {
                    canonicalPath = dir.getCanonicalPath();
                } catch (Exception e) {
                    canonicalPath = dir.getAbsolutePath();
                }
                String folderId = computeFsFolderId(canonicalPath);
                String folderName = (customName != null && !customName.trim().isEmpty())
                    ? customName.trim()
                    : (dir.getName() != null && !dir.getName().isEmpty() ? dir.getName() : "Lokální složka");

                savePersistedFsFolder(folderId, folderName, canonicalPath);

                JSArray files = new JSArray();
                scanFileDirectoryRecursive(dir, folderId, "", 0, files);

                JSObject ret = new JSObject();
                ret.put("folderId", folderId);
                ret.put("folderName", folderName);
                ret.put("files", files);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Nepodařilo se otevřít složku: " + e.getMessage(), e);
            }
        });
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
            if (hasAllFilesPermission()) {
                try {
                    SharedPreferences fsPrefs = getContext().getSharedPreferences(PREFS_FS, Context.MODE_PRIVATE);
                    Map<String, ?> allFs = fsPrefs.getAll();
                    for (Map.Entry<String, ?> entry : allFs.entrySet()) {
                        Object rawVal = entry.getValue();
                        if (!(rawVal instanceof String)) continue;
                        try {
                            JSONObject obj = new JSONObject((String) rawVal);
                            String path = obj.optString("path", "");
                            if (path.isEmpty()) continue;
                            File dir = new File(path);
                            if (!dir.exists() || !dir.isDirectory()) continue;
                            JSObject item = new JSObject();
                            item.put("folderId", obj.optString("folderId", entry.getKey()));
                            item.put("folderName", obj.optString("folderName", dir.getName()));
                            item.put("treeUri", Uri.fromFile(dir).toString());
                            item.put("updatedAtMs", obj.optLong("updatedAtMs", 0L));
                            folders.put(item);
                        } catch (Exception ignored) {
                        }
                    }
                } catch (Exception ignored) {
                }
            }
            try {
                ContentResolver resolver = getContext().getContentResolver();
                SharedPreferences prefs = getContext().getSharedPreferences(PREFS_SAF, Context.MODE_PRIVATE);
                Map<String, ?> all = prefs.getAll();
                for (Map.Entry<String, ?> entry : all.entrySet()) {
                    Object rawVal = entry.getValue();
                    if (!(rawVal instanceof String)) continue;
                    try {
                        JSONObject obj = new JSONObject((String) rawVal);
                        if (!obj.optBoolean("openedForCulling", true)) {
                            continue;
                        }
                        String uriStr = obj.optString("treeUri", "");
                        if (uriStr.isEmpty()) continue;
                        Uri treeUri = Uri.parse(uriStr);
                        if (!hasValidPersistedPermission(resolver, treeUri)) {
                            continue;
                        }
                        JSObject item = new JSObject();
                        item.put("folderId", obj.optString("folderId", entry.getKey()));
                        item.put("folderName", obj.optString("folderName", "Lokální složka"));
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
                // 1. Check direct filesystem persisted folders first
                String fsPath = getPersistedFsPath(folderId);
                if (fsPath != null) {
                    if (!hasAllFilesPermission()) {
                        call.reject("Chybí oprávnění pro přístup ke všem souborům.");
                        return;
                    }
                    File dir = new File(fsPath);
                    if (!dir.exists() || !dir.isDirectory()) {
                        call.reject("Uložená složka již v úložišti neexistuje.");
                        return;
                    }
                    String folderName = dir.getName() != null && !dir.getName().isEmpty()
                        ? dir.getName()
                        : "Lokální složka";
                    savePersistedFsFolder(folderId, folderName, fsPath);
                    JSArray files = new JSArray();
                    scanFileDirectoryRecursive(dir, folderId, "", 0, files);

                    JSObject ret = new JSObject();
                    ret.put("folderId", folderId);
                    ret.put("folderName", folderName);
                    ret.put("files", files);
                    call.resolve(ret);
                    return;
                }

                // 2. Fall back to persisted SAF tree / subfolder
                ContentResolver resolver = getContext().getContentResolver();
                Uri treeUri = getPersistedTreeUri(folderId);
                if (treeUri == null || !hasValidPersistedPermission(resolver, treeUri)) {
                    call.reject("Oprávnění k uložené složce vypršelo.");
                    return;
                }
                String docId = getPersistedSafDocId(folderId, treeUri);
                String folderName = extractDocumentDisplayName(resolver, treeUri, docId, "Lokální složka");
                savePersistedSafEntry(
                    folderId,
                    folderName,
                    treeUri,
                    docId,
                    docId.equals(DocumentsContract.getTreeDocumentId(treeUri))
                );

                JSArray files = new JSArray();
                scanDirectoryRecursive(resolver, treeUri, folderId, docId, "", 0, files);

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
                SharedPreferences fsPrefs = getContext().getSharedPreferences(PREFS_FS, Context.MODE_PRIVATE);
                fsPrefs.edit().remove(folderId).apply();
            } catch (Exception ignored) {
            }
            try {
                Uri treeUri = getPersistedTreeUri(folderId);
                SharedPreferences prefs = getContext().getSharedPreferences(PREFS_SAF, Context.MODE_PRIVATE);
                prefs.edit().remove(folderId).apply();
                if (treeUri != null) {
                    // Only release persistable permission if no other SAF root/entry still references this treeUri
                    String targetStr = treeUri.toString();
                    boolean stillReferenced = false;
                    for (Map.Entry<String, ?> e : prefs.getAll().entrySet()) {
                        if (!(e.getValue() instanceof String)) continue;
                        try {
                            JSONObject obj = new JSONObject((String) e.getValue());
                            if (targetStr.equals(obj.optString("treeUri", ""))) {
                                stillReferenced = true;
                                break;
                            }
                        } catch (Exception ignored) {
                        }
                    }
                    if (!stillReferenced) {
                        getContext().getContentResolver().releasePersistableUriPermission(
                            treeUri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        );
                    }
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

    private String findOrCreateSubfolderDocId(
        ContentResolver resolver,
        Uri treeUri,
        String parentDocId,
        String subfolderName
    ) throws Exception {
        String baseDocId = (parentDocId != null && !parentDocId.isEmpty())
            ? parentDocId
            : DocumentsContract.getTreeDocumentId(treeUri);
        String existing = findSubfolderDocId(resolver, treeUri, baseDocId, subfolderName);
        if (existing != null) return existing;

        Uri baseDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, baseDocId);
        Uri createdUri = DocumentsContract.createDocument(
            resolver,
            baseDocUri,
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
                String fsPath = getPersistedFsPath(folderId);
                if (fsPath != null) {
                    File subDir = new File(fsPath, subfolderName);
                    if (subDir.exists() && subDir.isDirectory()) {
                        File[] children = subDir.listFiles();
                        if (children != null) {
                            for (File f : children) {
                                if (f != null && f.isFile() && f.getName() != null && !f.getName().trim().isEmpty()) {
                                    arr.put(f.getName().trim());
                                }
                            }
                        }
                    }
                    JSObject ret = new JSObject();
                    ret.put("names", arr);
                    call.resolve(ret);
                    return;
                }

                Uri treeUri = getPersistedTreeUri(folderId);
                if (treeUri != null) {
                    ContentResolver resolver = getContext().getContentResolver();
                    String baseDocId = getPersistedSafDocId(folderId, treeUri);
                    String subDocId = findSubfolderDocId(resolver, treeUri, baseDocId, subfolderName);
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
                byte[] outBytes;

                if (isFileSchemeUri(uriStr)) {
                    File file = resolveFileFromUri(uriStr);
                    if (file == null || !file.exists() || !file.isFile()) {
                        call.reject("Soubor nebyl nalezen.");
                        return;
                    }
                    try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
                        long fileSize = raf.length();
                        if (fileSize <= 0 || start >= fileSize) {
                            outBytes = new byte[0];
                        } else {
                            int toRead = (int) Math.min((long) maxLen, fileSize - start);
                            byte[] buf = new byte[toRead];
                            raf.seek(start);
                            int total = 0;
                            while (total < toRead) {
                                int r = raf.read(buf, total, toRead - total);
                                if (r <= 0) break;
                                total += r;
                            }
                            outBytes = (total == toRead) ? buf : Arrays.copyOf(buf, total);
                        }
                    }
                } else {
                    Uri uri = Uri.parse(uriStr);
                    ContentResolver resolver = getContext().getContentResolver();

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

        thumbExecutor.execute(() -> {
            String dataUrl = null;
            try {
                if (isFileSchemeUri(uriStr)) {
                    File file = resolveFileFromUri(uriStr);
                    if (file == null || !file.exists() || !file.isFile()) {
                        JSObject empty = new JSObject();
                        empty.put("dataUrl", JSObject.NULL);
                        call.resolve(empty);
                        return;
                    }
                    String ext = getExtensionLower(file.getName());
                    if (!RASTER_THUMB_EXTS.contains(ext)) {
                        JSObject rawRet = new JSObject();
                        rawRet.put("dataUrl", JSObject.NULL);
                        call.resolve(rawRet);
                        return;
                    }
                    BitmapFactory.Options bounds = new BitmapFactory.Options();
                    bounds.inJustDecodeBounds = true;
                    BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
                    Bitmap bmp = null;
                    if (bounds.outWidth > 0 && bounds.outHeight > 0) {
                        int sample = 1;
                        int maxDim = Math.max(bounds.outWidth, bounds.outHeight);
                        while (maxDim / (sample * 2) >= 240) {
                            sample *= 2;
                        }
                        BitmapFactory.Options decodeOpts = new BitmapFactory.Options();
                        decodeOpts.inSampleSize = sample;
                        decodeOpts.inPreferredConfig = Bitmap.Config.RGB_565;
                        bmp = BitmapFactory.decodeFile(file.getAbsolutePath(), decodeOpts);
                        if (bmp != null) {
                            try {
                                ExifInterface exif = new ExifInterface(file.getAbsolutePath());
                                int orientation = exif.getAttributeInt(
                                    ExifInterface.TAG_ORIENTATION,
                                    ExifInterface.ORIENTATION_NORMAL
                                );
                                if (orientation > 1 && orientation <= 8) {
                                    bmp = applyExifOrientationTransform(bmp, orientation);
                                }
                            } catch (Exception ignored) {
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
                    JSObject ret = new JSObject();
                    ret.put("dataUrl", dataUrl != null ? dataUrl : JSObject.NULL);
                    call.resolve(ret);
                    return;
                }

                Uri uri = Uri.parse(uriStr);
                ContentResolver resolver = getContext().getContentResolver();

                String[] meta = queryNameAndMime(resolver, uri);
                String ext = getExtensionLower(meta[0]);
                if (ext.isEmpty()) {
                    ext = getExtensionLower(uri.getLastPathSegment());
                }
                // Skip OS DocumentsContract thumbnails for RAW files (CR3/NEF/ARW/CR2/etc.)
                // because Android returns embedded RAW thumbnails without applying CMT1/IFD0 EXIF orientation.
                if (!RASTER_THUMB_EXTS.contains(ext)) {
                    JSObject rawRet = new JSObject();
                    rawRet.put("dataUrl", JSObject.NULL);
                    call.resolve(rawRet);
                    return;
                }

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
                                    if (orientation > 1 && orientation <= 8) {
                                        bmp = applyExifOrientationTransform(bmp, orientation);
                                    }
                                }
                            } catch (Exception ignored) {
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

    private int readUint16Endian(byte[] buf, int off, boolean littleEndian) {
        if (off < 0 || off + 2 > buf.length) return 0;
        int b0 = buf[off] & 0xFF;
        int b1 = buf[off + 1] & 0xFF;
        return littleEndian ? (b0 | (b1 << 8)) : ((b0 << 8) | b1);
    }

    private long readUint32Endian(byte[] buf, int off, boolean littleEndian) {
        if (off < 0 || off + 4 > buf.length) return 0L;
        long b0 = buf[off] & 0xFFL;
        long b1 = buf[off + 1] & 0xFFL;
        long b2 = buf[off + 2] & 0xFFL;
        long b3 = buf[off + 3] & 0xFFL;
        return littleEndian
            ? (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24))
            : ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3);
    }

    private int parseTiffOrientationAt(byte[] buf, int tiffStart, int maxLen) {
        if (tiffStart < 0 || tiffStart + 8 > buf.length || maxLen < 8) return 0;
        int endLimit = Math.min(buf.length, tiffStart + maxLen);
        boolean le;
        if (buf[tiffStart] == 0x49 && buf[tiffStart + 1] == 0x49) {
            le = true;
        } else if (buf[tiffStart] == 0x4D && buf[tiffStart + 1] == 0x4D) {
            le = false;
        } else {
            return 0;
        }
        long ifdRel = readUint32Endian(buf, tiffStart + 4, le);
        if (ifdRel < 8 || tiffStart + ifdRel + 2 > endLimit) return 0;
        int ifdOff = tiffStart + (int) ifdRel;
        int count = readUint16Endian(buf, ifdOff, le);
        int entriesBase = ifdOff + 2;
        for (int i = 0; i < count && i < 256; i++) {
            int entryOff = entriesBase + i * 12;
            if (entryOff + 12 > endLimit) break;
            int tag = readUint16Endian(buf, entryOff, le);
            if (tag == 0x0112) {
                int val = readUint16Endian(buf, entryOff + 8, le);
                if (val >= 1 && val <= 8) return val;
            }
        }
        return 0;
    }

    private int detectRawContainerOrientation(byte[] buf, int len) {
        if (len < 16) return 1;
        // 1. Direct TIFF header (CR2, NEF, ARW, DNG, ORF, RW2, PEF)
        int directTiff = parseTiffOrientationAt(buf, 0, len);
        if (directTiff >= 1 && directTiff <= 8) {
            return directTiff;
        }
        // 2. Canon CR3 ISO BMFF: scan for 'CMT1' box containing IFD0 TIFF header
        int cmtScanLimit = Math.min(len, 1024 * 1024);
        for (int i = 4; i + 16 < cmtScanLimit; i++) {
            if (buf[i] == 0x43 && buf[i + 1] == 0x4D && buf[i + 2] == 0x54 && buf[i + 3] == 0x31) {
                int boxSize = (int) readUint32Endian(buf, i - 4, false);
                int payloadStart = i + 4;
                int payloadLen = boxSize > 8 ? Math.min(boxSize - 8, len - payloadStart) : (len - payloadStart);
                int cmtOri = parseTiffOrientationAt(buf, payloadStart, payloadLen);
                if (cmtOri >= 1 && cmtOri <= 8) {
                    return cmtOri;
                }
            }
        }
        return 1;
    }

    private Bitmap applyExifOrientationTransform(Bitmap bmp, int orientation) {
        if (bmp == null || orientation <= 1 || orientation > 8) return bmp;
        Matrix m = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
                m.setScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_180:
                m.setRotate(180f);
                break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL:
                m.setScale(1f, -1f);
                break;
            case ExifInterface.ORIENTATION_TRANSPOSE:
                m.setRotate(90f);
                m.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_90:
                m.setRotate(90f);
                break;
            case ExifInterface.ORIENTATION_TRANSVERSE:
                m.setRotate(270f);
                m.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_270:
                m.setRotate(270f);
                break;
            default:
                return bmp;
        }
        try {
            Bitmap transformed = Bitmap.createBitmap(
                bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true
            );
            if (transformed != null && transformed != bmp) {
                bmp.recycle();
                return transformed;
            }
        } catch (Throwable ignored) {
        }
        return bmp;
    }

    private byte[] readUriHeadBytes(ContentResolver resolver, Uri uri, int maxBytes) {
        if (uri != null && "file".equalsIgnoreCase(uri.getScheme())) {
            File file = resolveFileFromUri(uri.toString());
            if (file == null || !file.exists() || !file.isFile()) return null;
            try (FileInputStream fis = new FileInputStream(file);
                 FileChannel channel = fis.getChannel()) {
                long fileSize = channel.size();
                int toRead = fileSize > 0
                    ? (int) Math.min((long) maxBytes, fileSize)
                    : maxBytes;
                if (toRead <= 0) return null;
                ByteBuffer bb = ByteBuffer.allocate(toRead);
                int total = 0;
                while (total < toRead) {
                    int r = channel.read(bb);
                    if (r <= 0) break;
                    total += r;
                }
                return total == toRead ? bb.array() : Arrays.copyOf(bb.array(), total);
            } catch (Exception ignored) {
                return null;
            }
        }
        try (ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "r")) {
            if (pfd != null) {
                try (FileInputStream fis = new FileInputStream(pfd.getFileDescriptor());
                     FileChannel channel = fis.getChannel()) {
                    long fileSize = channel.size();
                    int toRead = fileSize > 0
                        ? (int) Math.min((long) maxBytes, fileSize)
                        : maxBytes;
                    if (toRead <= 0) return null;
                    ByteBuffer bb = ByteBuffer.allocate(toRead);
                    int total = 0;
                    while (total < toRead) {
                        int r = channel.read(bb);
                        if (r <= 0) break;
                        total += r;
                    }
                    return total == toRead ? bb.array() : Arrays.copyOf(bb.array(), total);
                }
            }
        } catch (Exception fallbackEx) {
            try (InputStream is = resolver.openInputStream(uri)) {
                if (is != null) {
                    ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.min(maxBytes, 131072));
                    byte[] chunk = new byte[32768];
                    int left = maxBytes;
                    while (left > 0) {
                        int r = is.read(chunk, 0, Math.min(chunk.length, left));
                        if (r <= 0) break;
                        bos.write(chunk, 0, r);
                        left -= r;
                    }
                    return bos.toByteArray();
                }
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private int[] findFastThumbnailJpegRange(byte[] buf, int len) {
        int bestStart = -1;
        int bestLen = 0;
        int bestScore = -1;

        // 1. Canon CR3 PRVW box ('PRVW' + 16-byte header + 4-byte jpegSize + JPEG)
        for (int i = 4; i + 24 < len; i++) {
            if (buf[i] == 0x50 && buf[i + 1] == 0x52 && buf[i + 2] == 0x56 && buf[i + 3] == 0x57) {
                int jpegSize = (int) readUint32Endian(buf, i + 16, false);
                int jpegStart = i + 20;
                if (jpegSize > 4096 && jpegStart + jpegSize <= len
                    && (buf[jpegStart] & 0xFF) == 0xFF && (buf[jpegStart + 1] & 0xFF) == 0xD8) {
                    BitmapFactory.Options opts = new BitmapFactory.Options();
                    opts.inJustDecodeBounds = true;
                    BitmapFactory.decodeByteArray(buf, jpegStart, jpegSize, opts);
                    if (opts.outWidth >= 160 && opts.outHeight >= 120) {
                        return new int[] { jpegStart, jpegSize };
                    }
                }
            }
        }

        // 2. General SOI..EOI scan (catches Canon THMB 160x120 as well as PRVW / Track 1 / NEF / ARW / DNG)
        int searchPos = 0;
        int candidatesChecked = 0;
        while (searchPos + 4 < len && candidatesChecked < 32) {
            int soi = -1;
            for (int i = searchPos; i + 3 < len; i++) {
                if ((buf[i] & 0xFF) == 0xFF
                    && (buf[i + 1] & 0xFF) == 0xD8
                    && (buf[i + 2] & 0xFF) == 0xFF) {
                    int m = buf[i + 3] & 0xFF;
                    if (m == 0xDB || m == 0xE0 || m == 0xE1 || m == 0xE2 || m == 0xEE || m == 0xC0 || m == 0xC4) {
                        soi = i;
                        break;
                    }
                }
            }
            if (soi < 0) break;

            int cursor = soi + 2;
            int eoiEnd = -1;
            while (cursor + 1 < len) {
                if ((buf[cursor] & 0xFF) != 0xFF) {
                    cursor++;
                    continue;
                }
                while (cursor < len && (buf[cursor] & 0xFF) == 0xFF) {
                    cursor++;
                }
                if (cursor >= len) break;
                int marker = buf[cursor++] & 0xFF;
                if (marker == 0x00 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01) {
                    continue;
                }
                if (marker == 0xD9) {
                    eoiEnd = cursor;
                    break;
                }
                if (marker == 0xDA) {
                    while (cursor + 1 < len) {
                        if ((buf[cursor] & 0xFF) == 0xFF) {
                            int nextB = buf[cursor + 1] & 0xFF;
                            if (nextB == 0xD9) {
                                eoiEnd = cursor + 2;
                                break;
                            }
                        }
                        cursor++;
                    }
                    break;
                }
                if (cursor + 2 > len) break;
                int segLen = ((buf[cursor] & 0xFF) << 8) | (buf[cursor + 1] & 0xFF);
                if (segLen < 2 || cursor + segLen > len) break;
                cursor += segLen;
            }

            if (eoiEnd > soi + 1536) {
                candidatesChecked++;
                int candLen = eoiEnd - soi;
                BitmapFactory.Options opts = new BitmapFactory.Options();
                opts.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(buf, soi, candLen, opts);
                if (opts.outWidth >= 120 && opts.outHeight >= 90) {
                    int pixels = opts.outWidth * opts.outHeight;
                    if (pixels > bestScore) {
                        bestScore = pixels;
                        bestStart = soi;
                        bestLen = candLen;
                    }
                    if (opts.outWidth >= 320) {
                        break;
                    }
                }
                searchPos = eoiEnd;
            } else {
                searchPos = soi + 2;
            }
        }

        if (bestStart >= 0 && bestLen > 0) {
            return new int[] { bestStart, bestLen };
        }
        return null;
    }

    private int[] findBestEmbeddedJpegRange(byte[] buf, int len) {
        int bestStart = -1;
        int bestLen = 0;
        int bestScore = -1;

        // Fast check for Canon CR3 PRVW box ('PRVW' followed by 14-byte header + 4-byte jpegSize + JPEG)
        for (int i = 4; i + 24 < len; i++) {
            if (buf[i] == 0x50 && buf[i + 1] == 0x52 && buf[i + 2] == 0x56 && buf[i + 3] == 0x57) {
                int jpegSize = (int) readUint32Endian(buf, i + 16, false);
                int jpegStart = i + 20;
                if (jpegSize > 8192 && jpegStart + jpegSize <= len
                    && (buf[jpegStart] & 0xFF) == 0xFF && (buf[jpegStart + 1] & 0xFF) == 0xD8) {
                    BitmapFactory.Options opts = new BitmapFactory.Options();
                    opts.inJustDecodeBounds = true;
                    BitmapFactory.decodeByteArray(buf, jpegStart, jpegSize, opts);
                    if (opts.outWidth >= 240 && opts.outHeight >= 160) {
                        bestStart = jpegStart;
                        bestLen = jpegSize;
                        bestScore = opts.outWidth * opts.outHeight;
                    }
                }
            }
        }

        // General SOI..EOI scan across buffer (catches Canon CR3 mdat Track 1 full-res JPEG, NEF, ARW, CR2, DNG, RAF)
        int searchPos = 0;
        int candidatesChecked = 0;
        while (searchPos + 4 < len && candidatesChecked < 40) {
            int soi = -1;
            for (int i = searchPos; i + 3 < len; i++) {
                if ((buf[i] & 0xFF) == 0xFF
                    && (buf[i + 1] & 0xFF) == 0xD8
                    && (buf[i + 2] & 0xFF) == 0xFF) {
                    int m = buf[i + 3] & 0xFF;
                    if (m == 0xDB || m == 0xE0 || m == 0xE1 || m == 0xE2 || m == 0xEE || m == 0xC0 || m == 0xC4) {
                        soi = i;
                        break;
                    }
                }
            }
            if (soi < 0) break;

            // Walk JPEG markers from SOI to matching EOI (skips nested EXIF thumbnail EOIs!)
            int cursor = soi + 2;
            int eoiEnd = -1;
            while (cursor + 1 < len) {
                if ((buf[cursor] & 0xFF) != 0xFF) {
                    cursor++;
                    continue;
                }
                while (cursor < len && (buf[cursor] & 0xFF) == 0xFF) {
                    cursor++;
                }
                if (cursor >= len) break;
                int marker = buf[cursor++] & 0xFF;
                if (marker == 0x00 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01) {
                    continue;
                }
                if (marker == 0xD9) {
                    eoiEnd = cursor;
                    break;
                }
                if (marker == 0xDA) {
                    // Entropy-coded scan data: scan forward to next unescaped FF D9 (skipping FF 00 and FF D0..D7)
                    while (cursor + 1 < len) {
                        if ((buf[cursor] & 0xFF) == 0xFF) {
                            int nextB = buf[cursor + 1] & 0xFF;
                            if (nextB == 0xD9) {
                                eoiEnd = cursor + 2;
                                break;
                            }
                        }
                        cursor++;
                    }
                    break;
                }
                if (cursor + 2 > len) break;
                int segLen = ((buf[cursor] & 0xFF) << 8) | (buf[cursor + 1] & 0xFF);
                if (segLen < 2 || cursor + segLen > len) break;
                cursor += segLen;
            }

            if (eoiEnd > soi + 8192) {
                candidatesChecked++;
                int candLen = eoiEnd - soi;
                BitmapFactory.Options opts = new BitmapFactory.Options();
                opts.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(buf, soi, candLen, opts);
                if (opts.outWidth >= 240 && opts.outHeight >= 160) {
                    int pixels = opts.outWidth * opts.outHeight;
                    if (pixels > bestScore) {
                        bestScore = pixels;
                        bestStart = soi;
                        bestLen = candLen;
                    }
                }
                searchPos = eoiEnd;
            } else {
                searchPos = soi + 2;
            }
        }

        if (bestStart >= 0 && bestLen > 0) {
            return new int[] { bestStart, bestLen };
        }
        return null;
    }

    @PluginMethod
    public void extractRawThumbnail(PluginCall call) {
        final String uriStr = call.getString("uri", "");
        if (uriStr == null || uriStr.isEmpty()) {
            JSObject empty = new JSObject();
            empty.put("filePath", JSObject.NULL);
            call.resolve(empty);
            return;
        }

        thumbExecutor.execute(() -> {
            try {
                File thumbDir = new File(getContext().getCacheDir(), "raw_thumbs_v2");
                if (!thumbDir.exists()) {
                    thumbDir.mkdirs();
                }
                String cacheName = "rthumb_" + Integer.toUnsignedString(uriStr.hashCode(), 36) + "_" + uriStr.length() + ".jpg";
                File outFile = new File(thumbDir, cacheName);

                if (outFile.exists() && outFile.length() > 1024L) {
                    JSObject hit = new JSObject();
                    hit.put("filePath", outFile.getAbsolutePath());
                    hit.put("orientation", 1);
                    call.resolve(hit);
                    return;
                }

                // Also reuse existing sharp raw_previews_v2 if already cached & small? Still generate fast 360px thumb for grid stability
                Uri uri = Uri.parse(uriStr);
                ContentResolver resolver = getContext().getContentResolver();

                // Fast path reads only 1.5 MB header (covers CMT1 + THMB + PRVW on almost all CR3/RAW files)
                byte[] headBytes = readUriHeadBytes(resolver, uri, 1536 * 1024);
                int[] range = (headBytes != null && headBytes.length >= 64)
                    ? findFastThumbnailJpegRange(headBytes, headBytes.length)
                    : null;

                // Secondary path for unusual RAW layouts where preview lies between 1.5 MB and 5 MB
                if (range == null) {
                    byte[] deeper = readUriHeadBytes(resolver, uri, 5 * 1024 * 1024);
                    if (deeper != null && deeper.length >= 64) {
                        headBytes = deeper;
                        range = findFastThumbnailJpegRange(headBytes, headBytes.length);
                    }
                }

                if (headBytes == null || range == null) {
                    JSObject empty = new JSObject();
                    empty.put("filePath", JSObject.NULL);
                    call.resolve(empty);
                    return;
                }

                int rawOrientation = detectRawContainerOrientation(headBytes, headBytes.length);
                if (rawOrientation <= 1) {
                    int innerOri = parseTiffOrientationAt(headBytes, range[0] + 10, Math.min(range[1], 65536));
                    if (innerOri >= 1 && innerOri <= 8) {
                        rawOrientation = innerOri;
                    }
                }

                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(headBytes, range[0], range[1], bounds);

                int sample = 1;
                int maxDim = Math.max(bounds.outWidth, bounds.outHeight);
                while (maxDim / (sample * 2) >= 240) {
                    sample *= 2;
                }

                BitmapFactory.Options decodeOpts = new BitmapFactory.Options();
                decodeOpts.inSampleSize = sample;
                decodeOpts.inPreferredConfig = Bitmap.Config.RGB_565;
                Bitmap bmp = BitmapFactory.decodeByteArray(headBytes, range[0], range[1], decodeOpts);

                if (bmp == null) {
                    JSObject empty = new JSObject();
                    empty.put("filePath", JSObject.NULL);
                    call.resolve(empty);
                    return;
                }

                if (rawOrientation > 1 && rawOrientation <= 8) {
                    bmp = applyExifOrientationTransform(bmp, rawOrientation);
                }

                File tempOut = new File(thumbDir, cacheName + ".tmp");
                try (FileOutputStream fos = new FileOutputStream(tempOut)) {
                    bmp.compress(Bitmap.CompressFormat.JPEG, 82, fos);
                    fos.flush();
                } finally {
                    bmp.recycle();
                }

                if (outFile.exists()) {
                    outFile.delete();
                }
                if (!tempOut.renameTo(outFile)) {
                    outFile = tempOut;
                }

                JSObject ret = new JSObject();
                ret.put("filePath", outFile.getAbsolutePath());
                ret.put("orientation", 1);
                call.resolve(ret);
            } catch (Throwable e) {
                JSObject empty = new JSObject();
                empty.put("filePath", JSObject.NULL);
                call.resolve(empty);
            }
        });
    }

    @PluginMethod
    public void extractRawPreview(PluginCall call) {
        final String uriStr = call.getString("uri", "");
        if (uriStr == null || uriStr.isEmpty()) {
            JSObject empty = new JSObject();
            empty.put("filePath", JSObject.NULL);
            call.resolve(empty);
            return;
        }

        ioExecutor.execute(() -> {
            try {
                File previewDir = new File(getContext().getCacheDir(), "raw_previews_v2");
                if (!previewDir.exists()) {
                    previewDir.mkdirs();
                }
                String cacheName = "raw_" + Integer.toUnsignedString(uriStr.hashCode(), 36) + ".jpg";
                File outFile = new File(previewDir, cacheName);

                if (outFile.exists() && outFile.length() > 4096L) {
                    int cachedOri = 1;
                    try {
                        ExifInterface cachedExif = new ExifInterface(outFile.getAbsolutePath());
                        cachedOri = cachedExif.getAttributeInt(
                            ExifInterface.TAG_ORIENTATION,
                            ExifInterface.ORIENTATION_NORMAL
                        );
                    } catch (Exception ignored) {
                    }
                    JSObject hit = new JSObject();
                    hit.put("filePath", outFile.getAbsolutePath());
                    hit.put("orientation", cachedOri);
                    call.resolve(hit);
                    return;
                }

                Uri uri = Uri.parse(uriStr);
                ContentResolver resolver = getContext().getContentResolver();
                int maxHeadBytes = 12 * 1024 * 1024; // 12 MB covers CR3 mdat Track 1 JPEG & all RAW previews
                byte[] headBytes = null;
                byte[] tailBytes = null;

                if (isFileSchemeUri(uriStr)) {
                    File file = resolveFileFromUri(uriStr);
                    if (file != null && file.exists() && file.isFile()) {
                        try (FileInputStream fis = new FileInputStream(file);
                             FileChannel channel = fis.getChannel()) {
                            long fileSize = channel.size();
                            int toRead = fileSize > 0
                                ? (int) Math.min((long) maxHeadBytes, fileSize)
                                : maxHeadBytes;
                            ByteBuffer bb = ByteBuffer.allocate(toRead);
                            int total = 0;
                            while (total < toRead) {
                                int r = channel.read(bb);
                                if (r <= 0) break;
                                total += r;
                            }
                            headBytes = total == toRead ? bb.array() : Arrays.copyOf(bb.array(), total);

                            if (fileSize > total + 65536L) {
                                int tailRead = (int) Math.min(2L * 1024L * 1024L, fileSize - total);
                                ByteBuffer tailBb = ByteBuffer.allocate(tailRead);
                                channel.position(fileSize - tailRead);
                                int tTotal = 0;
                                while (tTotal < tailRead) {
                                    int r = channel.read(tailBb);
                                    if (r <= 0) break;
                                    tTotal += r;
                                }
                                tailBytes = tTotal == tailRead
                                    ? tailBb.array()
                                    : Arrays.copyOf(tailBb.array(), tTotal);
                            }
                        }
                    }
                } else {
                    try (ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "r")) {
                        if (pfd != null) {
                            try (FileInputStream fis = new FileInputStream(pfd.getFileDescriptor());
                                 FileChannel channel = fis.getChannel()) {
                                long fileSize = channel.size();
                                int toRead = fileSize > 0
                                    ? (int) Math.min((long) maxHeadBytes, fileSize)
                                    : maxHeadBytes;
                                ByteBuffer bb = ByteBuffer.allocate(toRead);
                                int total = 0;
                                while (total < toRead) {
                                    int r = channel.read(bb);
                                    if (r <= 0) break;
                                    total += r;
                                }
                                headBytes = total == toRead ? bb.array() : Arrays.copyOf(bb.array(), total);

                                if (fileSize > total + 65536L) {
                                    int tailRead = (int) Math.min(2L * 1024L * 1024L, fileSize - total);
                                    ByteBuffer tailBb = ByteBuffer.allocate(tailRead);
                                    channel.position(fileSize - tailRead);
                                    int tTotal = 0;
                                    while (tTotal < tailRead) {
                                        int r = channel.read(tailBb);
                                        if (r <= 0) break;
                                        tTotal += r;
                                    }
                                    tailBytes = tTotal == tailRead
                                        ? tailBb.array()
                                        : Arrays.copyOf(tailBb.array(), tTotal);
                                }
                            }
                        }
                    } catch (Exception fallbackEx) {
                        try (InputStream is = resolver.openInputStream(uri)) {
                            if (is != null) {
                                ByteArrayOutputStream bos = new ByteArrayOutputStream(524288);
                                byte[] chunk = new byte[32768];
                                int left = maxHeadBytes;
                                while (left > 0) {
                                    int r = is.read(chunk, 0, Math.min(chunk.length, left));
                                    if (r <= 0) break;
                                    bos.write(chunk, 0, r);
                                    left -= r;
                                }
                                headBytes = bos.toByteArray();
                            }
                        }
                    }
                }

                if (headBytes == null || headBytes.length < 64) {
                    JSObject empty = new JSObject();
                    empty.put("filePath", JSObject.NULL);
                    call.resolve(empty);
                    return;
                }

                int rawOrientation = detectRawContainerOrientation(headBytes, headBytes.length);
                byte[] sourceBuf = headBytes;
                int[] range = findBestEmbeddedJpegRange(headBytes, headBytes.length);

                if (range == null && tailBytes != null && tailBytes.length > 8192) {
                    range = findBestEmbeddedJpegRange(tailBytes, tailBytes.length);
                    if (range != null) {
                        sourceBuf = tailBytes;
                    }
                }

                if (range == null) {
                    JSObject empty = new JSObject();
                    empty.put("filePath", JSObject.NULL);
                    call.resolve(empty);
                    return;
                }

                File tempOut = new File(previewDir, cacheName + ".tmp");
                try (FileOutputStream fos = new FileOutputStream(tempOut)) {
                    fos.write(sourceBuf, range[0], range[1]);
                    fos.flush();
                }

                if (rawOrientation > 1 && rawOrientation <= 8) {
                    boolean stamped = false;
                    try {
                        ExifInterface outExif = new ExifInterface(tempOut.getAbsolutePath());
                        int existingOri = outExif.getAttributeInt(
                            ExifInterface.TAG_ORIENTATION,
                            ExifInterface.ORIENTATION_UNDEFINED
                        );
                        if (existingOri <= 1) {
                            outExif.setAttribute(
                                ExifInterface.TAG_ORIENTATION,
                                String.valueOf(rawOrientation)
                            );
                            outExif.saveAttributes();
                        }
                        stamped = true;
                    } catch (Exception ignored) {
                    }

                    if (!stamped) {
                        int deg = 0;
                        if (rawOrientation == ExifInterface.ORIENTATION_ROTATE_90) deg = 90;
                        else if (rawOrientation == ExifInterface.ORIENTATION_ROTATE_180) deg = 180;
                        else if (rawOrientation == ExifInterface.ORIENTATION_ROTATE_270) deg = 270;
                        if (deg != 0) {
                            Bitmap decoded = BitmapFactory.decodeFile(tempOut.getAbsolutePath());
                            if (decoded != null) {
                                Matrix m = new Matrix();
                                m.postRotate(deg);
                                Bitmap rotated = Bitmap.createBitmap(
                                    decoded, 0, 0, decoded.getWidth(), decoded.getHeight(), m, true
                                );
                                if (rotated != decoded) {
                                    decoded.recycle();
                                }
                                try (FileOutputStream rotOut = new FileOutputStream(tempOut)) {
                                    rotated.compress(Bitmap.CompressFormat.JPEG, 92, rotOut);
                                }
                                rotated.recycle();
                            }
                        }
                    }
                }

                if (outFile.exists()) {
                    outFile.delete();
                }
                if (!tempOut.renameTo(outFile)) {
                    outFile = tempOut;
                }

                JSObject ret = new JSObject();
                ret.put("filePath", outFile.getAbsolutePath());
                ret.put("orientation", rawOrientation);
                call.resolve(ret);
            } catch (Exception e) {
                JSObject empty = new JSObject();
                empty.put("filePath", JSObject.NULL);
                call.resolve(empty);
            }
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

    private void executeDirectFsSubfolderTransfer(
        PluginCall call,
        File baseDir,
        String subfolderName,
        JSArray urisArray,
        boolean deleteSourceAfter
    ) {
        JSArray succeeded = new JSArray();
        JSArray failed = new JSArray();
        List<String> changedPaths = new ArrayList<>();

        File targetSubDir = new File(baseDir, subfolderName);
        if (!targetSubDir.exists() && !targetSubDir.mkdirs()) {
            call.reject("Nelze vytvořit podsložku " + subfolderName);
            return;
        }

        boolean skipDuplicates = "liked".equalsIgnoreCase(subfolderName.trim());
        Set<String> existingLower = new HashSet<>();
        if (skipDuplicates) {
            File[] existing = targetSubDir.listFiles();
            if (existing != null) {
                for (File f : existing) {
                    if (f != null && f.isFile() && f.getName() != null) {
                        existingLower.add(f.getName().trim().toLowerCase(Locale.ROOT));
                    }
                }
            }
        }

        byte[] copyBuf = new byte[65536];
        for (int i = 0; i < urisArray.length(); i++) {
            String uriStr = "";
            try {
                uriStr = urisArray.getString(i);
                File srcFile = resolveFileFromUri(uriStr);
                if (srcFile == null || !srcFile.exists() || !srcFile.isFile()) {
                    throw new IllegalStateException("Zdrojový soubor nebyl nalezen.");
                }
                String fileName = srcFile.getName();
                String lowerKey = fileName.trim().toLowerCase(Locale.ROOT);
                if (skipDuplicates && existingLower.contains(lowerKey)) {
                    succeeded.put(uriStr);
                    continue;
                }

                File destFile = new File(targetSubDir, fileName);
                if (destFile.exists() && !skipDuplicates) {
                    String stem = fileName;
                    String ext = "";
                    int dot = fileName.lastIndexOf('.');
                    if (dot > 0) {
                        stem = fileName.substring(0, dot);
                        ext = fileName.substring(dot);
                    }
                    int suffix = 1;
                    while (destFile.exists() && suffix < 1000) {
                        destFile = new File(targetSubDir, stem + "_" + suffix + ext);
                        suffix++;
                    }
                }

                boolean movedAtomically = false;
                if (deleteSourceAfter) {
                    movedAtomically = srcFile.renameTo(destFile);
                }

                if (!movedAtomically) {
                    File tempDest = new File(targetSubDir, destFile.getName() + ".selectra_tmp");
                    boolean copyOk = false;
                    try (FileInputStream in = new FileInputStream(srcFile);
                         FileOutputStream out = new FileOutputStream(tempDest)) {
                        int read;
                        while ((read = in.read(copyBuf)) != -1) {
                            out.write(copyBuf, 0, read);
                        }
                        out.flush();
                        copyOk = true;
                    } finally {
                        if (!copyOk && tempDest.exists()) {
                            tempDest.delete();
                        }
                    }
                    if (!tempDest.renameTo(destFile)) {
                        if (tempDest.exists()) tempDest.delete();
                        throw new IllegalStateException("Nepodařilo se uložit cílový soubor.");
                    }
                    if (deleteSourceAfter) {
                        srcFile.delete();
                    }
                }

                existingLower.add(lowerKey);
                changedPaths.add(destFile.getAbsolutePath());
                if (deleteSourceAfter) {
                    changedPaths.add(srcFile.getAbsolutePath());
                }
                succeeded.put(uriStr);
            } catch (Exception e) {
                JSObject errObj = new JSObject();
                errObj.put("uri", uriStr);
                errObj.put("error", e.getMessage() != null ? e.getMessage() : "Chyba zápisu");
                failed.put(errObj);
            }
        }

        if (!changedPaths.isEmpty()) {
            try {
                MediaScannerConnection.scanFile(
                    getContext(),
                    changedPaths.toArray(new String[0]),
                    null,
                    null
                );
            } catch (Exception ignored) {
            }
        }

        JSObject ret = new JSObject();
        ret.put("succeeded", succeeded);
        ret.put("failed", failed);
        call.resolve(ret);
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
            // Check if this is a direct filesystem folder or file:// URIs
            String fsPath = getPersistedFsPath(folderId);
            String firstUriStr = urisArray.optString(0, "");
            if (fsPath != null || isFileSchemeUri(firstUriStr)) {
                File baseDir = fsPath != null ? new File(fsPath) : null;
                if (baseDir == null || !baseDir.isDirectory()) {
                    File firstFile = resolveFileFromUri(firstUriStr);
                    if (firstFile != null) {
                        baseDir = firstFile.getParentFile();
                    }
                }
                if (baseDir == null || !baseDir.exists()) {
                    call.reject("Cílová složka v úložišti nebyla nalezena.");
                    return;
                }
                executeDirectFsSubfolderTransfer(call, baseDir, subfolderName, urisArray, deleteSourceAfter);
                return;
            }

            JSArray succeeded = new JSArray();
            JSArray failed = new JSArray();
            ContentResolver resolver = getContext().getContentResolver();

            Uri treeUri = resolveTreeUriWithFallback(folderId, urisArray);
            if (treeUri == null) {
                call.reject("Chybí oprávnění pro zápis do vybrané složky.");
                return;
            }

            String baseDocId = getPersistedSafDocId(folderId, treeUri);
            String targetSubDocId;
            try {
                targetSubDocId = findOrCreateSubfolderDocId(resolver, treeUri, baseDocId, subfolderName);
            } catch (Exception e) {
                call.reject("Nelze vytvořit podsložku " + subfolderName + ": " + e.getMessage(), e);
                return;
            }

            Uri targetSubUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, targetSubDocId);
            Uri baseDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, baseDocId);

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
                            Uri parentUri = baseDocUri;
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
            List<String> deletedPaths = new ArrayList<>();
            ContentResolver resolver = getContext().getContentResolver();

            for (int i = 0; i < urisArray.length(); i++) {
                String uriStr = "";
                try {
                    uriStr = urisArray.getString(i);
                    if (isFileSchemeUri(uriStr)) {
                        File f = resolveFileFromUri(uriStr);
                        if (f != null && (!f.exists() || f.delete())) {
                            deletedPaths.add(f.getAbsolutePath());
                            succeeded.put(uriStr);
                        } else {
                            JSObject errObj = new JSObject();
                            errObj.put("uri", uriStr);
                            errObj.put("error", "Systém Android nepovolil smazání souboru.");
                            failed.put(errObj);
                        }
                    } else {
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
                    }
                } catch (Exception e) {
                    JSObject errObj = new JSObject();
                    errObj.put("uri", uriStr);
                    errObj.put("error", e.getMessage() != null ? e.getMessage() : "Chyba mazání");
                    failed.put(errObj);
                }
            }

            if (!deletedPaths.isEmpty()) {
                try {
                    MediaScannerConnection.scanFile(
                        getContext(),
                        deletedPaths.toArray(new String[0]),
                        null,
                        null
                    );
                } catch (Exception ignored) {
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

    private String getApkSigningSha1() {
        try {
            Context ctx = getContext();
            PackageManager pm = ctx.getPackageManager();
            Signature[] sigs = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageInfo pi = pm.getPackageInfo(
                    ctx.getPackageName(),
                    PackageManager.GET_SIGNING_CERTIFICATES
                );
                if (pi.signingInfo != null) {
                    sigs = pi.signingInfo.hasMultipleSigners()
                        ? pi.signingInfo.getApkContentsSigners()
                        : pi.signingInfo.getSigningCertificateHistory();
                }
            } else {
                PackageInfo pi = pm.getPackageInfo(
                    ctx.getPackageName(),
                    PackageManager.GET_SIGNATURES
                );
                sigs = pi.signatures;
            }
            if (sigs != null && sigs.length > 0 && sigs[0] != null) {
                MessageDigest md = MessageDigest.getInstance("SHA-1");
                byte[] digest = md.digest(sigs[0].toByteArray());
                StringBuilder sb = new StringBuilder(digest.length * 3);
                for (int i = 0; i < digest.length; i++) {
                    if (i > 0) sb.append(':');
                    sb.append(String.format(Locale.US, "%02X", digest[i] & 0xFF));
                }
                return sb.toString();
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private GoogleSignInClient buildGoogleClient(String webClientId, String loginHint) {
        // Do NOT pass webClientId to requestIdToken(...) here: an unlinked or external Web Client ID
        // causes Play Services to fail immediately with ApiException 10 (DEVELOPER_ERROR) + RESULT_CANCELED.
        // Drive API access on Android only requires requestEmail() + DRIVE_SCOPE +GoogleAuthUtil.getToken().
        GoogleSignInOptions.Builder builder = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestEmail()
            .requestScopes(new Scope(DRIVE_SCOPE));
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
        pendingSignInUsedWebClient = false;

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
            // IMPORTANT: Check configuration errors (10 = DEVELOPER_ERROR, 12500 = SIGN_IN_FAILED)
            // BEFORE checking Activity.RESULT_CANCELED, because Play Services returns RESULT_CANCELED
            // alongside status code 10 / 12500!
            if (code == 10) {
                String sha1 = getApkSigningSha1();
                String sha1Hint = sha1 != null ? (" SHA-1 této APK: " + sha1) : "";
                call.reject(
                    "Přihlášení přes Google v APK selhalo (chyba 10 – chybí otisk SHA-1 ve Firebase). " +
                    "Přidejte otisk SHA-1 do Firebase Console (Nastavení projektu → Android aplikace com.selectra.app)." +
                    sha1Hint
                );
                return;
            }
            if (code == 12500) {
                String sha1 = getApkSigningSha1();
                String sha1Hint = sha1 != null ? (" SHA-1 této APK: " + sha1) : "";
                call.reject(
                    "Přihlášení přes Google selhalo (chyba 12500 – zkontrolujte v Google Cloud Console obrazovku souhlasu OAuth " +
                    "a případně přidejte svůj e-mail mezi testovací uživatele, pokud je OAuth v režimu Testing)." +
                    sha1Hint
                );
                return;
            }
            if (code == 12501 || code == 12502 || (code == 8 && result.getResultCode() == Activity.RESULT_CANCELED)) {
                JSObject cancelled = new JSObject();
                cancelled.put("cancelled", true);
                call.resolve(cancelled);
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
            String sha1 = getApkSigningSha1();
            JSObject ret = new JSObject();
            ret.put("versionName", pInfo.versionName != null ? pInfo.versionName : "");
            ret.put("versionCode", vCode);
            ret.put("packageName", ctx.getPackageName());
            ret.put("canInstallPackages", canInstall);
            ret.put("hasPendingApk", pendingUpdateApkFile != null && pendingUpdateApkFile.exists());
            ret.put("sha1Fingerprint", sha1 != null ? sha1 : JSObject.NULL);
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
