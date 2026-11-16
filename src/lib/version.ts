const envVersion = (
  import.meta as unknown as { env?: Record<string, string | undefined> }
).env?.VITE_APP_VERSION;

export const APP_VERSION =
  envVersion && envVersion.trim() ? envVersion.trim() : 'v2.16.0';

const envBuild = (
  import.meta as unknown as { env?: Record<string, string | undefined> }
).env?.VITE_APP_BUILD_NUMBER;

export const APP_BUILD_NUMBER =
  envBuild && envBuild.trim() ? envBuild.trim() : null;
