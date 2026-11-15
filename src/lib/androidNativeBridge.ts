import { Capacitor, registerPlugin } from '@capacitor/core';
import type {
  FrameCullNativeBridge,
  NativeBatchOpResult,
  NativePersistedFolderInfo,
  NativePickResult,
} from './localMedia';

interface SelectraNativePluginContract {
  pickDirectoryTree(): Promise<NativePickResult & { cancelled?: boolean }>;
  listPersistedFolders(): Promise<{ folders: NativePersistedFolderInfo[] }>;
  openPersistedDirectoryTree(options: {
    folderId: string;
  }): Promise<NativePickResult & { cancelled?: boolean }>;
  forgetPersistedFolder(options: { folderId: string }): Promise<void>;
  listSubfolderFileNames(options: {
    folderId: string;
    subfolderName: string;
  }): Promise<{ names: string[] }>;
  readFileSlice(options: {
    uri: string;
    start: number;
    end: number;
  }): Promise<{ data: string }>;
  getThumbnail(options: {
    uri: string;
  }): Promise<{ dataUrl?: string | null }>;
  copyToSubfolder(options: {
    folderId: string;
    subfolderName: string;
    fileUris: string[];
  }): Promise<NativeBatchOpResult>;
  moveToSubfolder(options: {
    folderId: string;
    subfolderName: string;
    fileUris: string[];
  }): Promise<NativeBatchOpResult>;
  deleteFilesPermanently(options: {
    fileUris: string[];
  }): Promise<NativeBatchOpResult>;
  triggerHaptic(options: {
    intensity: 'light' | 'medium' | 'heavy';
    kind: string;
  }): Promise<void>;
  googleSignIn(options: {
    webClientId: string;
    forceAccountSelect?: boolean;
    loginHint?: string | null;
  }): Promise<{
    cancelled?: boolean;
    idToken?: string;
    accessToken?: string;
    email?: string | null;
  }>;
  silentRefreshDriveToken(options: {
    webClientId: string;
    invalidateToken?: string | null;
  }): Promise<{
    available?: boolean;
    idToken?: string;
    accessToken?: string;
    email?: string | null;
  }>;
  googleSignOut(): Promise<void>;
}

const SelectraNative =
  registerPlugin<SelectraNativePluginContract>('SelectraNative');

export function isCapacitorNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function initAndroidNativeBridge(): void {
  if (typeof window === 'undefined') return;
  if (!isCapacitorNativeApp()) return;
  if (window.FrameCullNative) return;

  const bridge: FrameCullNativeBridge = {
    isAvailable() {
      return true;
    },

    async pickDirectoryTree() {
      const res = await SelectraNative.pickDirectoryTree();
      if (!res || res.cancelled || !res.folderId) return null;
      return {
        folderId: res.folderId,
        folderName: res.folderName || 'Složka v telefonu',
        files: Array.isArray(res.files) ? res.files : [],
      };
    },

    async listPersistedFolders() {
      try {
        const res = await SelectraNative.listPersistedFolders();
        return Array.isArray(res?.folders) ? res.folders : [];
      } catch {
        return [];
      }
    },

    async openPersistedDirectoryTree(folderId: string) {
      const res = await SelectraNative.openPersistedDirectoryTree({ folderId });
      if (!res || res.cancelled || !res.folderId) return null;
      return {
        folderId: res.folderId,
        folderName: res.folderName || 'Složka v telefonu',
        files: Array.isArray(res.files) ? res.files : [],
      };
    },

    async forgetPersistedFolder(folderId: string) {
      try {
        await SelectraNative.forgetPersistedFolder({ folderId });
      } catch {
        // Ignore cleanup errors
      }
    },

    async listSubfolderFileNames(folderId: string, subfolderName: string) {
      try {
        const res = await SelectraNative.listSubfolderFileNames({
          folderId,
          subfolderName,
        });
        return Array.isArray(res?.names) ? res.names : [];
      } catch {
        return [];
      }
    },

    async readFileSlice(uri: string, start: number, end: number) {
      const res = await SelectraNative.readFileSlice({ uri, start, end });
      return res.data;
    },

    async getThumbnailUrl(uri: string) {
      if (!uri) return null;
      try {
        const res = await SelectraNative.getThumbnail({ uri });
        return res?.dataUrl || null;
      } catch {
        return null;
      }
    },

    async getFullMediaUrl(uri: string) {
      if (!uri) return null;
      return Capacitor.convertFileSrc(uri);
    },

    async moveToSubfolderTrash(folderId: string, fileUris: string[]) {
      return await SelectraNative.moveToSubfolder({
        folderId,
        subfolderName: '_Vyrazene',
        fileUris,
      });
    },

    async copyToSubfolder(
      folderId: string,
      subfolderName: string,
      fileUris: string[]
    ) {
      return await SelectraNative.copyToSubfolder({
        folderId,
        subfolderName,
        fileUris,
      });
    },

    async moveToSubfolder(
      folderId: string,
      subfolderName: string,
      fileUris: string[]
    ) {
      return await SelectraNative.moveToSubfolder({
        folderId,
        subfolderName,
        fileUris,
      });
    },

    async deleteFilesPermanently(fileUris: string[]) {
      return await SelectraNative.deleteFilesPermanently({ fileUris });
    },

    async triggerHaptic(
      intensity: 'light' | 'medium' | 'heavy',
      kind: string
    ) {
      try {
        await SelectraNative.triggerHaptic({ intensity, kind });
      } catch {
        // Ignore vibration failures
      }
    },

    async googleSignInNative(options) {
      const res = await SelectraNative.googleSignIn({
        webClientId: options.webClientId,
        forceAccountSelect: Boolean(options.forceAccountSelect),
        loginHint: options.loginHint ?? null,
      });
      if (!res || res.cancelled || !res.accessToken) {
        return null;
      }
      return {
        idToken: res.idToken || '',
        accessToken: res.accessToken,
        email: res.email ?? null,
      };
    },

    async silentRefreshDriveToken(options) {
      try {
        const res = await SelectraNative.silentRefreshDriveToken({
          webClientId: options.webClientId,
          invalidateToken: options.invalidateToken ?? null,
        });
        if (!res || !res.available || !res.accessToken) {
          return null;
        }
        return {
          idToken: res.idToken || '',
          accessToken: res.accessToken,
          email: res.email ?? null,
        };
      } catch {
        return null;
      }
    },

    async googleSignOutNative() {
      try {
        await SelectraNative.googleSignOut();
      } catch {
        // Ignore native signout errors
      }
    },
  };

  window.FrameCullNative = bridge;
}
