import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithCredential,
  signInWithPopup,
  User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'] as const;

const OAUTH_STORAGE_KEY = 'selectra_drive_oauth_v1';
const EXPLICIT_LOGOUT_KEY = 'selectra_explicit_logout_v1';
const REMEMBERED_EMAIL_KEY = 'selectra_remembered_email_v1';
const DEFAULT_TOKEN_TTL_MS = 55 * 60 * 1000;
const EXPIRY_SAFETY_MARGIN_MS = 90 * 1000;

export interface AppAuthUser {
  uid: string;
  email: string | null;
  isFirebaseSynced: boolean;
}

interface StoredDriveOAuthSession {
  accessToken: string;
  uid: string;
  email: string | null;
  isFirebaseSynced?: boolean;
  expiresAtMs: number;
}

const persistenceReadyPromise = setPersistence(
  auth,
  browserLocalPersistence
).catch(() => {
  // Fallback to default Firebase persistence if IndexedDB/localStorage is restricted
});

let isSigningIn = false;
let cachedAccessToken: string | null = null;
let cachedTokenUid: string | null = null;
let inflightNativeRefresh: Promise<{
  user: AppAuthUser;
  accessToken: string;
} | null> | null = null;

function toAppAuthUser(firebaseUser: User): AppAuthUser {
  return {
    uid: firebaseUser.uid,
    email: firebaseUser.email,
    isFirebaseSynced: true,
  };
}

function buildNativeFallbackUser(email?: string | null): AppAuthUser {
  const cleanEmail = email && email.trim() ? email.trim().toLowerCase() : null;
  return {
    uid: `native:${cleanEmail || 'google-drive'}`,
    email: email && email.trim() ? email.trim() : getRememberedGoogleEmail(),
    isFirebaseSynced: false,
  };
}

function getWebOAuthClientId(): string {
  return (firebaseConfig as { oAuthClientId?: string }).oAuthClientId || '';
}

export function getRememberedGoogleEmail(): string | null {
  try {
    const val = window.localStorage.getItem(REMEMBERED_EMAIL_KEY);
    return val && val.trim() ? val.trim() : null;
  } catch {
    return null;
  }
}

function saveRememberedGoogleEmail(email?: string | null) {
  if (!email || !email.trim()) return;
  try {
    window.localStorage.setItem(REMEMBERED_EMAIL_KEY, email.trim());
  } catch {
    // Ignore storage errors
  }
}

function clearRememberedGoogleEmail() {
  try {
    window.localStorage.removeItem(REMEMBERED_EMAIL_KEY);
  } catch {
    // Ignore storage errors
  }
}

function buildGoogleProvider(options?: {
  forceAccountSelect?: boolean;
  loginHint?: string | null;
}): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  for (const scope of DRIVE_SCOPES) {
    provider.addScope(scope);
  }
  const params: Record<string, string> = {};
  if (options?.forceAccountSelect) {
    params.prompt = 'select_account';
  }
  if (options?.loginHint) {
    params.login_hint = options.loginHint;
  }
  if (Object.keys(params).length > 0) {
    provider.setCustomParameters(params);
  }
  return provider;
}

function readStoredDriveSession(
  expectedUid?: string
): StoredDriveOAuthSession | null {
  try {
    const raw = window.localStorage.getItem(OAUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDriveOAuthSession>;
    if (
      typeof parsed.accessToken !== 'string' ||
      !parsed.accessToken ||
      typeof parsed.uid !== 'string' ||
      !parsed.uid ||
      typeof parsed.expiresAtMs !== 'number'
    ) {
      return null;
    }
    if (expectedUid && parsed.uid !== expectedUid) {
      return null;
    }
    if (parsed.expiresAtMs <= Date.now() + 30_000) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      uid: parsed.uid,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      isFirebaseSynced: Boolean(parsed.isFirebaseSynced),
      expiresAtMs: parsed.expiresAtMs,
    };
  } catch {
    return null;
  }
}

function persistDriveSession(session: StoredDriveOAuthSession) {
  cachedAccessToken = session.accessToken;
  cachedTokenUid = session.uid;
  saveRememberedGoogleEmail(session.email);
  try {
    window.localStorage.setItem(OAUTH_STORAGE_KEY, JSON.stringify(session));
    window.localStorage.removeItem(EXPLICIT_LOGOUT_KEY);
  } catch {
    // Ignore storage quota / private-mode errors
  }
}

function clearStoredDriveSession() {
  cachedAccessToken = null;
  cachedTokenUid = null;
  try {
    window.localStorage.removeItem(OAUTH_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

function wasExplicitLogout(): boolean {
  try {
    return window.localStorage.getItem(EXPLICIT_LOGOUT_KEY) === '1';
  } catch {
    return false;
  }
}

function refineTokenExpiryInBackground(
  accessToken: string,
  uid: string,
  email: string | null,
  isFirebaseSynced: boolean
) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  )
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { expires_in?: string | number } | null) => {
      if (!data || data.expires_in === undefined) return;
      const sec = Number(data.expires_in);
      if (!Number.isFinite(sec) || sec <= 0) return;
      if (cachedAccessToken !== accessToken || cachedTokenUid !== uid) return;
      const exactExpiry = Math.max(
        Date.now() + 60_000,
        Date.now() + sec * 1000 - EXPIRY_SAFETY_MARGIN_MS
      );
      persistDriveSession({
        accessToken,
        uid,
        email,
        isFirebaseSynced,
        expiresAtMs: exactExpiry,
      });
    })
    .catch(() => {
      // Keep conservative 55-minute fallback TTL
    });
}

async function tryExchangeFirebaseCredential(
  idToken: string | undefined,
  accessToken: string
): Promise<User | null> {
  if (idToken) {
    try {
      const cred = GoogleAuthProvider.credential(idToken, accessToken);
      const res = await signInWithCredential(auth, cred);
      return res.user;
    } catch {
      // Fall back to accessToken-only Firebase exchange below
    }
  }
  try {
    const fallbackCred = GoogleAuthProvider.credential(null, accessToken);
    const res = await signInWithCredential(auth, fallbackCred);
    return res.user;
  } catch {
    return null;
  }
}

export async function trySilentNativeDriveRefresh(
  invalidateOldToken = false
): Promise<{ user: AppAuthUser; accessToken: string } | null> {
  if (typeof window === 'undefined') return null;
  const silentFn = window.FrameCullNative?.silentRefreshDriveToken;
  if (!silentFn) return null;
  if (wasExplicitLogout()) return null;

  if (inflightNativeRefresh) {
    return inflightNativeRefresh;
  }

  inflightNativeRefresh = (async () => {
    try {
      const tokenToInvalidate = invalidateOldToken ? cachedAccessToken : null;
      if (invalidateOldToken) {
        clearStoredDriveSession();
      }
      const nativeRes = await silentFn({
        webClientId: getWebOAuthClientId(),
        invalidateToken: tokenToInvalidate,
      });
      if (!nativeRes || !nativeRes.accessToken) {
        return null;
      }

      let currentUser = auth.currentUser;
      if (!currentUser) {
        currentUser = await tryExchangeFirebaseCredential(
          nativeRes.idToken,
          nativeRes.accessToken
        );
      }

      const appUser = currentUser
        ? toAppAuthUser(currentUser)
        : buildNativeFallbackUser(nativeRes.email);

      persistDriveSession({
        accessToken: nativeRes.accessToken,
        uid: appUser.uid,
        email: appUser.email,
        isFirebaseSynced: appUser.isFirebaseSynced,
        expiresAtMs: Date.now() + DEFAULT_TOKEN_TTL_MS,
      });
      refineTokenExpiryInBackground(
        nativeRes.accessToken,
        appUser.uid,
        appUser.email,
        appUser.isFirebaseSynced
      );

      return {
        user: appUser,
        accessToken: nativeRes.accessToken,
      };
    } catch {
      return null;
    } finally {
      inflightNativeRefresh = null;
    }
  })();

  return inflightNativeRefresh;
}

export const initAuth = (
  onAuthSuccess?: (user: AppAuthUser, token: string) => void,
  onSessionWithoutToken?: (user: AppAuthUser) => void,
  onSignedOut?: () => void
) => {
  let cancelled = false;
  let unsubscribeAuth: (() => void) | null = null;

  persistenceReadyPromise.finally(() => {
    if (cancelled) return;
    unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser: User | null) => {
      if (firebaseUser) {
        const appUser = toAppAuthUser(firebaseUser);
        saveRememberedGoogleEmail(firebaseUser.email);
        if (cachedAccessToken && cachedTokenUid === firebaseUser.uid) {
          onAuthSuccess?.(appUser, cachedAccessToken);
          return;
        }
        const stored = readStoredDriveSession(firebaseUser.uid);
        if (stored) {
          cachedAccessToken = stored.accessToken;
          cachedTokenUid = stored.uid;
          onAuthSuccess?.(appUser, stored.accessToken);
          return;
        }
        if (!isSigningIn) {
          if (window.FrameCullNative?.silentRefreshDriveToken) {
            void trySilentNativeDriveRefresh(false).then((refreshed) => {
              if (cancelled) return;
              if (refreshed?.accessToken) {
                onAuthSuccess?.(
                  refreshed.user.isFirebaseSynced ? refreshed.user : appUser,
                  refreshed.accessToken
                );
              } else {
                clearStoredDriveSession();
                onSessionWithoutToken?.(appUser);
              }
            });
            return;
          }
          clearStoredDriveSession();
          onSessionWithoutToken?.(appUser);
        }
      } else {
        if (!isSigningIn && !wasExplicitLogout()) {
          // Restore valid stored native Drive session immediately if still fresh
          const storedNative = readStoredDriveSession();
          if (storedNative && storedNative.uid.startsWith('native:')) {
            cachedAccessToken = storedNative.accessToken;
            cachedTokenUid = storedNative.uid;
            onAuthSuccess?.(
              {
                uid: storedNative.uid,
                email: storedNative.email,
                isFirebaseSynced: false,
              },
              storedNative.accessToken
            );
            return;
          }
          if (window.FrameCullNative?.silentRefreshDriveToken) {
            void trySilentNativeDriveRefresh(false).then((refreshed) => {
              if (cancelled) return;
              if (refreshed?.accessToken) {
                onAuthSuccess?.(refreshed.user, refreshed.accessToken);
              } else {
                clearStoredDriveSession();
                onSignedOut?.();
              }
            });
            return;
          }
        }
        clearStoredDriveSession();
        onSignedOut?.();
      }
    });
  });

  return () => {
    cancelled = true;
    if (unsubscribeAuth) {
      unsubscribeAuth();
    }
  };
};

export const googleSignIn = async (options?: {
  forceAccountSelect?: boolean;
  loginHint?: string | null;
}): Promise<{
  user: AppAuthUser;
  accessToken: string;
} | null> => {
  try {
    isSigningIn = true;
    await persistenceReadyPromise;
    const hint =
      options?.loginHint ??
      auth.currentUser?.email ??
      getRememberedGoogleEmail() ??
      null;
    const shouldPromptSelect =
      options?.forceAccountSelect ?? (!hint && wasExplicitLogout());

    if (window.FrameCullNative?.googleSignInNative) {
      const nativeRes = await window.FrameCullNative.googleSignInNative({
        webClientId: getWebOAuthClientId(),
        forceAccountSelect: shouldPromptSelect,
        loginHint: shouldPromptSelect ? null : hint,
      });
      if (!nativeRes || !nativeRes.accessToken) {
        return null;
      }

      const firebaseUser = await tryExchangeFirebaseCredential(
        nativeRes.idToken,
        nativeRes.accessToken
      );

      const appUser = firebaseUser
        ? toAppAuthUser(firebaseUser)
        : buildNativeFallbackUser(nativeRes.email);

      persistDriveSession({
        accessToken: nativeRes.accessToken,
        uid: appUser.uid,
        email: appUser.email,
        isFirebaseSynced: appUser.isFirebaseSynced,
        expiresAtMs: Date.now() + DEFAULT_TOKEN_TTL_MS,
      });
      refineTokenExpiryInBackground(
        nativeRes.accessToken,
        appUser.uid,
        appUser.email,
        appUser.isFirebaseSynced
      );
      return { user: appUser, accessToken: nativeRes.accessToken };
    }

    const provider = buildGoogleProvider({
      forceAccountSelect: shouldPromptSelect,
      loginHint: shouldPromptSelect ? null : hint,
    });
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Nepodařilo se získat přístupový token z Google účtu.');
    }
    const token = credential.accessToken;
    const appUser = toAppAuthUser(result.user);
    persistDriveSession({
      accessToken: token,
      uid: appUser.uid,
      email: appUser.email,
      isFirebaseSynced: true,
      expiresAtMs: Date.now() + DEFAULT_TOKEN_TTL_MS,
    });
    refineTokenExpiryInBackground(token, appUser.uid, appUser.email, true);
    return { user: appUser, accessToken: token };
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  if (cachedAccessToken) return cachedAccessToken;
  const uid = auth.currentUser?.uid;
  const stored = readStoredDriveSession(uid);
  if (stored) {
    cachedAccessToken = stored.accessToken;
    cachedTokenUid = stored.uid;
    return stored.accessToken;
  }
  const refreshed = await trySilentNativeDriveRefresh(false);
  return refreshed?.accessToken ?? null;
};

export const clearAccessToken = () => {
  clearStoredDriveSession();
};

export const logout = async () => {
  clearStoredDriveSession();
  clearRememberedGoogleEmail();
  try {
    window.localStorage.setItem(EXPLICIT_LOGOUT_KEY, '1');
  } catch {
    // Ignore storage errors
  }
  await window.FrameCullNative?.googleSignOutNative?.();
  await auth.signOut().catch(() => {
    // Ignore signOut errors when only native session was active
  });
};
