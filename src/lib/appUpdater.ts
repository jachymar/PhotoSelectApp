import { APP_BUILD_NUMBER, APP_VERSION } from './version';
import type {
  NativeApkDownloadProgress,
  NativeApkInstallResult,
  NativeAppBuildInfo,
} from './localMedia';

const STORAGE_REPO_KEY = 'selectra_update_repo_v1';
const STORAGE_TOKEN_KEY = 'selectra_update_gh_token_v1';

interface GitHubReleaseAsset {
  id: number;
  name: string;
  size: number;
  content_type?: string;
  browser_download_url: string;
  url: string;
}

interface GitHubReleasePayload {
  tag_name: string;
  name?: string;
  body?: string;
  html_url: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubReleaseAsset[];
}

export interface InstalledVersionInfo {
  versionTag: string;
  versionCode: number | null;
  buildNumber: string | null;
  isNativeAndroid: boolean;
  hasPendingApk: boolean;
}

export interface ReleaseUpdateInfo {
  tagName: string;
  releaseTitle: string;
  publishedAt: string | null;
  releaseNotes: string;
  htmlUrl: string;
  apkName: string;
  apkSizeBytes: number;
  browserDownloadUrl: string;
  apiAssetUrl: string;
  remoteVersionCode: number | null;
}

export type UpdateCheckResult =
  | {
      status: 'update_available';
      installed: InstalledVersionInfo;
      release: ReleaseUpdateInfo;
      repo: string;
    }
  | {
      status: 'up_to_date';
      installed: InstalledVersionInfo;
      latestTag: string;
      repo: string;
    }
  | {
      status: 'repo_not_configured';
      installed: InstalledVersionInfo;
    }
  | {
      status: 'private_or_no_release';
      installed: InstalledVersionInfo;
      repo: string;
      hasToken: boolean;
    }
  | {
      status: 'error';
      installed: InstalledVersionInfo;
      repo: string;
      message: string;
    };

export function normalizeGitHubRepoSlug(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const withoutProtocol = trimmed
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = withoutProtocol.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return '';
}

export function getBakedGitHubRepo(): string {
  const raw = (
    import.meta as unknown as { env?: Record<string, string | undefined> }
  ).env?.VITE_GITHUB_REPO;
  return raw ? normalizeGitHubRepoSlug(raw) : '';
}

export function getConfiguredGitHubRepo(): string {
  try {
    const custom = window.localStorage.getItem(STORAGE_REPO_KEY);
    if (custom && custom.trim()) {
      const normalized = normalizeGitHubRepoSlug(custom);
      if (normalized) return normalized;
    }
  } catch {
    // Ignore storage errors
  }
  return getBakedGitHubRepo();
}

export function saveCustomGitHubRepo(repoInput: string): string {
  const normalized = normalizeGitHubRepoSlug(repoInput);
  try {
    if (normalized) {
      window.localStorage.setItem(STORAGE_REPO_KEY, normalized);
    } else {
      window.localStorage.removeItem(STORAGE_REPO_KEY);
    }
  } catch {
    // Ignore storage errors
  }
  return normalized;
}

export function getSavedGitHubToken(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_TOKEN_KEY);
    return raw && raw.trim() ? raw.trim() : '';
  } catch {
    return '';
  }
}

export function saveGitHubToken(token: string): void {
  try {
    const trimmed = token.trim();
    if (trimmed) {
      window.localStorage.setItem(STORAGE_TOKEN_KEY, trimmed);
    } else {
      window.localStorage.removeItem(STORAGE_TOKEN_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

function parseVersionSegments(versionStr: string): number[] {
  const cleaned = versionStr.trim().replace(/^v/i, '').split(/[-+]/)[0];
  return cleaned
    .split('.')
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

export function compareVersionTags(a: string, b: string): number {
  const segA = parseVersionSegments(a);
  const segB = parseVersionSegments(b);
  const len = Math.max(segA.length, segB.length);
  for (let i = 0; i < len; i++) {
    const va = segA[i] ?? 0;
    const vb = segB[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function extractRemoteVersionCode(body?: string): number | null {
  if (!body) return null;
  const match = body.match(/versionCode[:\s`]*(\d+)/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function getInstalledVersionInfo(): Promise<InstalledVersionInfo> {
  const nativeFn =
    typeof window !== 'undefined'
      ? window.FrameCullNative?.getAppBuildInfo
      : undefined;

  let nativeInfo: NativeAppBuildInfo | null = null;
  if (nativeFn) {
    nativeInfo = await nativeFn();
  }

  if (nativeInfo && nativeInfo.versionName) {
    const normalizedTag = nativeInfo.versionName.startsWith('v')
      ? nativeInfo.versionName
      : `v${nativeInfo.versionName}`;
    return {
      versionTag: normalizedTag,
      versionCode: nativeInfo.versionCode || null,
      buildNumber: APP_BUILD_NUMBER,
      isNativeAndroid: true,
      hasPendingApk: Boolean(nativeInfo.hasPendingApk),
    };
  }

  return {
    versionTag: APP_VERSION.startsWith('v') ? APP_VERSION : `v${APP_VERSION}`,
    versionCode: null,
    buildNumber: APP_BUILD_NUMBER,
    isNativeAndroid: Boolean(window?.FrameCullNative?.isAvailable?.()),
    hasPendingApk: false,
  };
}

export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  const installed = await getInstalledVersionInfo();
  const repo = getConfiguredGitHubRepo();

  if (!repo) {
    return {
      status: 'repo_not_configured',
      installed,
    };
  }

  const token = getSavedGitHubToken();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        method: 'GET',
        headers,
        cache: 'no-store',
      }
    );

    if (response.status === 404 || response.status === 401) {
      return {
        status: 'private_or_no_release',
        installed,
        repo,
        hasToken: Boolean(token),
      };
    }

    if (!response.ok) {
      return {
        status: 'error',
        installed,
        repo,
        message: `GitHub API vrátilo stav ${response.status}. Zkuste to za chvíli znovu.`,
      };
    }

    const data = (await response.json()) as GitHubReleasePayload;
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const apkAsset =
      assets.find((a) => a.name.toLowerCase().endsWith('.apk')) ||
      assets.find(
        (a) => a.content_type === 'application/vnd.android.package-archive'
      );

    if (!apkAsset) {
      return {
        status: 'error',
        installed,
        repo,
        message:
          'Nejnovější GitHub Release neobsahuje přiložený soubor Selectra.apk.',
      };
    }

    const remoteTag = data.tag_name.startsWith('v')
      ? data.tag_name
      : `v${data.tag_name}`;
    const remoteVersionCode = extractRemoteVersionCode(data.body);

    let isNewer = false;
    if (
      installed.versionCode !== null &&
      remoteVersionCode !== null &&
      remoteVersionCode !== installed.versionCode
    ) {
      isNewer = remoteVersionCode > installed.versionCode;
    } else {
      isNewer = compareVersionTags(remoteTag, installed.versionTag) > 0;
    }

    if (!isNewer) {
      return {
        status: 'up_to_date',
        installed,
        latestTag: remoteTag,
        repo,
      };
    }

    const cleanedNotes = (data.body || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();

    return {
      status: 'update_available',
      installed,
      repo,
      release: {
        tagName: remoteTag,
        releaseTitle: data.name || `Selectra ${remoteTag}`,
        publishedAt: data.published_at || null,
        releaseNotes: cleanedNotes,
        htmlUrl: data.html_url,
        apkName: apkAsset.name,
        apkSizeBytes: apkAsset.size,
        browserDownloadUrl: apkAsset.browser_download_url,
        apiAssetUrl: apkAsset.url,
        remoteVersionCode,
      },
    };
  } catch {
    return {
      status: 'error',
      installed,
      repo,
      message:
        'Nepodařilo se spojit se serverem GitHub. Zkontrolujte připojení k internetu.',
    };
  }
}

export async function startUpdateDownloadAndInstall(
  release: ReleaseUpdateInfo,
  onProgress?: (progress: NativeApkDownloadProgress) => void
): Promise<NativeApkInstallResult | { status: 'opened_browser' }> {
  const token = getSavedGitHubToken();
  const nativeDownload = window.FrameCullNative?.downloadAndInstallApk;

  if (nativeDownload) {
    let unsubscribe: (() => void) | null = null;
    if (onProgress && window.FrameCullNative?.onApkDownloadProgress) {
      unsubscribe = await window.FrameCullNative.onApkDownloadProgress(
        onProgress
      );
    }
    try {
      const targetUrl = token
        ? release.apiAssetUrl
        : release.browserDownloadUrl;
      return await nativeDownload({
        apkUrl: targetUrl,
        githubToken: token || null,
        versionTag: release.tagName,
      });
    } finally {
      if (unsubscribe) {
        unsubscribe();
      }
    }
  }

  await openReleaseUrlExternally(release.browserDownloadUrl || release.htmlUrl);
  return { status: 'opened_browser' };
}

export async function completePendingApkInstall(): Promise<NativeApkInstallResult | null> {
  if (!window.FrameCullNative?.installPendingApk) return null;
  return await window.FrameCullNative.installPendingApk();
}

export async function openReleaseUrlExternally(url: string): Promise<void> {
  if (window.FrameCullNative?.openExternalUrl) {
    await window.FrameCullNative.openExternalUrl(url);
    return;
  }
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function formatApkSizeMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1).replace('.', ',')} MB`;
}

export function formatCzechReleaseDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('cs-CZ', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  });
}
