import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useI18n } from '../lib/i18n';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { t } = useI18n();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-18 md:bottom-4 left-4 right-4 sm:right-auto z-50 flex items-center gap-2.5 rounded-xl border border-amber-500/40 bg-[#141417]/95 backdrop-blur-md px-3.5 py-2.5 text-xs font-medium text-amber-200 shadow-2xl"
    >
      <WifiOff className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
      <span>
        {t(
          'Režim offline — fotky v telefonu fungují bez omezení',
          'Offline mode — phone photos work without limits'
        )}
      </span>
    </div>
  );
};

