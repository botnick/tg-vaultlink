/**
 * VaultLink Mini App — bottom-tab navigation.
 *
 * Files / Bots / Settings / (Admin if admin). Active tab is filled
 * + underlined; tap fires a light haptic. Hidden by the Layout on
 * subroute pages (file/bot detail) so the user keeps screen real
 * estate for context.
 */

import { NavLink } from 'react-router-dom';
import { useAuth } from '../providers/AuthProvider.js';
import { useT } from '../lib/i18n.js';
import { hapticImpact } from '../lib/telegram.js';
import {
  AdminIcon,
  BotsIcon,
  FilesIcon,
  SettingsIcon,
} from './icons.js';

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
      className="fixed inset-x-0 bottom-0 z-40 border-t border-black/[0.06] bg-tg-header-bg/95 backdrop-blur-md dark:border-white/[0.06]"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
      aria-label="primary"
    >
      <ul className="no-scrollbar mx-auto flex max-w-md items-stretch overflow-x-auto">
        {tabs.map(({ to, labelKey, Icon }) => (
          <li key={to} className="flex-1">
            <NavLink
              to={to}
              onClick={() => hapticImpact('light')}
              className={({ isActive }) =>
                [
                  'press-scale flex h-14 flex-col items-center justify-center gap-0.5 px-2 text-[11px] font-medium transition-colors',
                  isActive ? 'text-tg-link' : 'text-tg-hint',
                ].join(' ')
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={22} filled={isActive} />
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
