/**
 * VaultLink Mini App — bottom-sheet confirmation dialog.
 *
 * Always used for destructive actions instead of `window.confirm`.
 * Closes on backdrop tap, Escape, or button click. The optional
 * `inputLabel` turns the dialog into a tiny prompt — convenient
 * for "Set password" / "Set expiry days" without spawning a
 * separate component for each.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../lib/i18n.js';
import { Button } from './Button.js';

interface Props {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  /** When set, the dialog renders an input and onConfirm receives the value. */
  inputLabel?: string;
  inputType?: 'text' | 'password' | 'number';
  inputPlaceholder?: string;
  inputDefaultValue?: string;
  onConfirm: (value?: string) => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: Props): JSX.Element | null {
  const {
    open,
    title,
    message,
    confirmLabel,
    cancelLabel,
    destructive = false,
    loading = false,
    inputLabel,
    inputType = 'text',
    inputPlaceholder,
    inputDefaultValue,
    onConfirm,
    onCancel,
  } = props;
  const t = useT();
  const [value, setValue] = useState(inputDefaultValue ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) setValue(inputDefaultValue ?? '');
  }, [open, inputDefaultValue]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    // Auto-focus the input on open.
    if (inputLabel) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 80);
      return () => {
        window.removeEventListener('keydown', handler);
        window.clearTimeout(id);
      };
    }
    return () => window.removeEventListener('keydown', handler);
  }, [open, inputLabel, onCancel]);

  if (!open) return null;

  const handleSubmit = (): void => {
    if (loading) return;
    onConfirm(inputLabel ? value : undefined);
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') handleSubmit();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel();
      }}
    >
      <div
        className="sheet-up w-full max-w-md rounded-t-3xl bg-tg-bg p-5 pb-[calc(1.25rem+var(--safe-bottom))] shadow-2xl"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-tg-hint/40" aria-hidden="true" />
        <h3 id="confirm-dialog-title" className="text-base font-semibold text-tg-text">
          {title}
        </h3>
        {message ? <div className="mt-2 text-sm text-tg-subtitle-text">{message}</div> : null}
        {inputLabel ? (
          <label className="mt-4 block">
            <span className="text-xs uppercase tracking-wide text-tg-hint">{inputLabel}</span>
            <input
              ref={inputRef}
              type={inputType}
              value={value}
              placeholder={inputPlaceholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onInputKey}
              className="mt-1 w-full rounded-2xl border border-black/10 bg-tg-secondary-bg px-3 py-2.5 text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
            />
          </label>
        ) : null}
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" block onClick={onCancel} disabled={loading}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            block
            loading={loading}
            onClick={handleSubmit}
          >
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
