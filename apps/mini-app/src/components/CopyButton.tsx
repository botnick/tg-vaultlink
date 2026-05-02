/**
 * VaultLink Mini App — small inline "copy to clipboard" pill.
 *
 * Tries the modern Clipboard API first, falls back to a hidden
 * textarea + `execCommand` so it still works inside older Telegram
 * webviews. Fires a haptic + transient success label on each copy.
 */

import { useState } from 'react';
import { CopyIcon, CheckIcon } from './icons.js';
import { hapticImpact, hapticNotify } from '../lib/telegram.js';
import { useT } from '../lib/i18n.js';

interface Props {
  value: string;
  label?: string;
  className?: string;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallthrough
  }
  // Legacy fallback for older webviews.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ value, label, className = '' }: Props): JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const onClick = async (): Promise<void> => {
    hapticImpact('light');
    const ok = await writeClipboard(value);
    if (ok) {
      hapticNotify('success');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'press-scale inline-flex items-center gap-1.5 rounded-full bg-tg-secondary-bg px-3 py-1 text-xs font-medium text-tg-link',
        className,
      ].join(' ')}
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      <span>{copied ? t('common.copied') : (label ?? t('common.copy'))}</span>
    </button>
  );
}
