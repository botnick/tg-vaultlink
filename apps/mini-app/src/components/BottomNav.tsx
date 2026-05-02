/**
 * VaultLink Mini App — bottom-tab navigation.
 *
 * Floating glass bar at the bottom: rounded pill, frosted backdrop,
 * brand-gradient indicator behind the active tab. Lives just above the
 * device's safe area so it doesn't crash into the home-bar on iOS.
 *
 * Hidden by the Layout on subroute pages (file/bot detail) so the user
 * keeps screen real estate for context.
 */

import { NavLink } from 'react-router-dom';
import { useAuth } from '../providers/AuthProvider.js';
import { useT } from '../lib/i18n.js';
import { hapticImpact } from '../lib/telegram.js';
import { AdminIcon, BotsIcon, FilesIcon, SettingsIcon } from './icons.js';

interface TabDef {
  to: string;
  labelKey: string;
  Icon: (p: { size?: number; filled?: boolean }) => JSX.Element;
}

export function BottomNav(): JSX.Element {
  const t = useT();
  const { isAdmin } = useAuth();

  const tabs: TabDef[] = [
    { to: '/files', labelKey: 'nav.files', Icon: FilesIcon },
    { to: '/bots', labelKey: 'nav.bots', Icon: BotsIcon },
    { to: '/settings', labelKey: 'nav.settings', Icon: SettingsIcon },
  ];
  if (isAdmin) tabs.push({ to: '/admin', labelKey: 'nav.admin', Icon: AdminIcon });

  return (
    <nav
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3"
      style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 10px)' }}
      aria-label="primary"
    >
      <ul className="pointer-events-auto no-scrollbar glass mx-auto flex w-full max-w-md items-stretch gap-1 overflow-x-auto rounded-full p-1.5 shadow-soft-lg">
        {tabs.map(({ to, labelKey, Icon }) => (
          <li key={to} className="flex-1">
            <NavLink
              to={to}
              onClick={() => hapticImpact('light')}
              className={({ isActive }) =>
                [
                  'press-scale relative flex h-12 flex-col items-center justify-center gap-0.5 rounded-full px-2 text-[11px] font-semibold transition-colors',
                  isActive
                    ? 'bg-gradient-hero text-white shadow-glow'
                    : 'text-tg-hint hover:text-tg-text',
                ].join(' ')
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={20} filled={isActive} />
                  <span className="leading-none">{t(labelKey)}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
