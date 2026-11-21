import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import {
  initAndroidNativeBridge,
  isCapacitorNativeApp,
} from './lib/androidNativeBridge';
import App from './App.tsx';
import './index.css';

initAndroidNativeBridge();

if (!isCapacitorNativeApp() && 'serviceWorker' in navigator) {
  if (import.meta.env.DEV) {
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) {
        if (reg.active?.scriptURL.includes('dev-sw')) {
          void reg.unregister();
        }
      }
    });
  } else {
    let hadController = Boolean(navigator.serviceWorker.controller);
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) {
        hadController = true;
        return;
      }
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        if (!registration) return;
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            void registration.update();
          }
        });
      },
    });
  }
}

createRoot(document.getElementById('root')!).render(<App />);
