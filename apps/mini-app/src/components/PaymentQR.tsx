/**
 * VaultLink Mini App — payment QR card.
 *
 * Wave 9.3 styled QR. The matrix is generated via `qrcode` at ECC level H,
 * then rendered as inline SVG with rounded "dot" modules, custom rounded
 * finder patterns at the three corners, and a brand-coloured logo punched
 * into the centre — the same look modern crypto wallets use (Wallet @send,
 * Trust, etc.). Stays scannable: dots cover ~80% of each module slot, ECC H
 * absorbs the centre logo, and the matrix colour stays high-contrast on
 * a white plate regardless of the Mini App's theme.
 *
 * Security: the encoded string comes verbatim from the server-built
 * `payment_uri` (or the bare address fallback). The component never
 * accepts a derived value from arbitrary user input.
 */

import { useMemo } from 'react';
import QRCode from 'qrcode';
import type { CryptoNetwork, CryptoToken } from '../lib/credits.api.js';
import { getColorScheme } from '../lib/telegram.js';
import { NETWORK_GRADIENT, NetworkIcon } from './NetworkIcon.js';

const NETWORK_LABEL: Record<CryptoNetwork, string> = {
  trx: 'TRC-20',
  bsc: 'BEP-20',
  eth: 'ERC-20',
  ton: 'TON',
};

const TOKEN_TINT: Record<CryptoToken, string> = {
  USDT: '#26A17B',
  USDC: '#2775CA',
  native: '#7AA2F7',
};

/**
 * Brand colour used for the QR matrix per network. Dark variants chosen to
 * keep contrast comfortable for any wallet camera while still reading as
 * the chain's brand colour at a glance.
 */
const MATRIX_COLOR: Record<CryptoNetwork, string> = {
  trx: '#C90916',
  bsc: '#A07A05',
  eth: '#454A75',
  ton: '#0073B5',
};

/** Default colour for the QR matrix when no network is given. */
const DEFAULT_MATRIX_COLOR = '#0B1437';

export interface PaymentQRProps {
  /** Server-built URI (BIP-21 / ton:// / etc.) or a plain address fallback. */
  data: string;
  /** Pixel size of the QR plate. Defaults to 260. */
  size?: number;
  /** Optional caption shown above the QR card. */
  caption?: string;
  /** Network bucket — drives the centre logo + matrix colour. */
  network?: CryptoNetwork;
  /** Token bucket — drives the bottom info chip. */
  token?: CryptoToken;
  /** Soft pulse to signal "waiting for payment". */
  pulse?: boolean;
}

interface QrMatrix {
  readonly size: number;
  readonly data: Uint8Array;
}

/**
 * Build the QR matrix once per `data`. Synchronous — `QRCode.create` returns
 * the matrix without needing a render target.
 */
function useQrMatrix(data: string): QrMatrix | null {
  return useMemo(() => {
    if (!data) return null;
    try {
      const qr = QRCode.create(data, { errorCorrectionLevel: 'H' });
      return { size: qr.modules.size, data: qr.modules.data };
    } catch {
      return null;
    }
  }, [data]);
}

/**
 * Top-left, top-right, bottom-left finder patterns. Used to skip those
 * positions during dot rendering so the special pattern shapes don't
 * overlap with circle modules.
 */
function isFinderModule(row: number, col: number, size: number): boolean {
  return (
    (row < 7 && col < 7) ||
    (row < 7 && col >= size - 7) ||
    (row >= size - 7 && col < 7)
  );
}

export function PaymentQR({
  data,
  size = 260,
  caption,
  network,
  token,
  pulse = false,
}: PaymentQRProps): JSX.Element {
  const matrix = useQrMatrix(data);
  const dark = getColorScheme() === 'dark';

  const moduleColor = network ? MATRIX_COLOR[network] : DEFAULT_MATRIX_COLOR;
  const matrixBg = '#FFFFFF';
  const cardBg = dark ? '#1B2331' : '#FFFFFF';
  const cardShadow = dark
    ? '0 14px 36px -16px rgba(0,0,0,0.55)'
    : '0 14px 36px -16px rgba(15,23,42,0.18)';

  // SVG layout constants. The full matrix lives inside a "quiet zone" margin
  // of 4 modules on each side, per the QR spec — every wallet expects it.
  const QUIET_MARGIN = 4;

  const svgPaths = useMemo(() => {
    if (!matrix) return null;
    const total = matrix.size + QUIET_MARGIN * 2;
    const m = matrix.size;
    const moduleSize = size / total;

    // Wallet-style modules: rounded squares whose corner radius is dropped
    // to 0 on edges that touch another "on" module. Adjacent modules merge
    // into a single fluid blob (the look used by Wallet / TonKeeper / Bitget),
    // while isolated modules render as full rounded squares.
    const isOn = (row: number, col: number): boolean => {
      if (row < 0 || col < 0 || row >= m || col >= m) return false;
      if (isFinderModule(row, col, m)) return false; // finders rendered separately
      return matrix.data[row * m + col] === 1;
    };

    const baseR = moduleSize * 0.5; // full rounding on isolated edges
    let dots = '';
    for (let row = 0; row < m; row++) {
      for (let col = 0; col < m; col++) {
        if (!matrix.data[row * m + col]) continue;
        if (isFinderModule(row, col, m)) continue;
        const x = (QUIET_MARGIN + col) * moduleSize;
        const y = (QUIET_MARGIN + row) * moduleSize;
        const w = moduleSize;
        const up = isOn(row - 1, col);
        const down = isOn(row + 1, col);
        const left = isOn(row, col - 1);
        const right = isOn(row, col + 1);
        const rTL = !up && !left ? baseR : 0;
        const rTR = !up && !right ? baseR : 0;
        const rBR = !down && !right ? baseR : 0;
        const rBL = !down && !left ? baseR : 0;
        // Custom path with per-corner radii; SVG `rx` only supports a single
        // radius so we hand-roll the path.
        dots +=
          `<path d="M${(x + rTL).toFixed(2)} ${y.toFixed(2)}` +
          `L${(x + w - rTR).toFixed(2)} ${y.toFixed(2)}` +
          (rTR > 0 ? `Q${(x + w).toFixed(2)} ${y.toFixed(2)} ${(x + w).toFixed(2)} ${(y + rTR).toFixed(2)}` : '') +
          `L${(x + w).toFixed(2)} ${(y + w - rBR).toFixed(2)}` +
          (rBR > 0 ? `Q${(x + w).toFixed(2)} ${(y + w).toFixed(2)} ${(x + w - rBR).toFixed(2)} ${(y + w).toFixed(2)}` : '') +
          `L${(x + rBL).toFixed(2)} ${(y + w).toFixed(2)}` +
          (rBL > 0 ? `Q${x.toFixed(2)} ${(y + w).toFixed(2)} ${x.toFixed(2)} ${(y + w - rBL).toFixed(2)}` : '') +
          `L${x.toFixed(2)} ${(y + rTL).toFixed(2)}` +
          (rTL > 0 ? `Q${x.toFixed(2)} ${y.toFixed(2)} ${(x + rTL).toFixed(2)} ${y.toFixed(2)}` : '') +
          `Z"/>`;
      }
    }

    /**
     * Render one finder pattern at module-coords (rowOff, colOff). We draw
     * three concentric rounded squares — outer brand colour, mid white,
     * inner brand colour — to mimic the `Wallet @send` look while staying
     * within the QR spec's 7×7 finder geometry.
     */
    const finderAt = (rowOff: number, colOff: number): string => {
      const x = (QUIET_MARGIN + colOff) * moduleSize;
      const y = (QUIET_MARGIN + rowOff) * moduleSize;
      const outerW = 7 * moduleSize;
      const midX = x + moduleSize;
      const midY = y + moduleSize;
      const midW = 5 * moduleSize;
      const inX = x + 2 * moduleSize;
      const inY = y + 2 * moduleSize;
      const inW = 3 * moduleSize;
      const rOuter = moduleSize * 1.8;
      const rMid = moduleSize * 1.1;
      const rIn = moduleSize * 0.75;
      return (
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${outerW.toFixed(2)}" height="${outerW.toFixed(2)}" rx="${rOuter.toFixed(2)}" ry="${rOuter.toFixed(2)}" fill="${moduleColor}"/>` +
        `<rect x="${midX.toFixed(2)}" y="${midY.toFixed(2)}" width="${midW.toFixed(2)}" height="${midW.toFixed(2)}" rx="${rMid.toFixed(2)}" ry="${rMid.toFixed(2)}" fill="${matrixBg}"/>` +
        `<rect x="${inX.toFixed(2)}" y="${inY.toFixed(2)}" width="${inW.toFixed(2)}" height="${inW.toFixed(2)}" rx="${rIn.toFixed(2)}" ry="${rIn.toFixed(2)}" fill="${moduleColor}"/>`
      );
    };

    const finders =
      finderAt(0, 0) + finderAt(0, m - 7) + finderAt(m - 7, 0);

    return { dots, finders };
  }, [matrix, moduleColor, size]);

  // Card frame measurements. Slightly larger inner padding + bigger logo
  // give the QR a softer, more wallet-grade silhouette without breaking
  // ECC tolerance (logo ~24% of total area; H-level ECC absorbs ~30%).
  const matrixPadding = 16;
  const cardPadding = 4;
  const cardSize = size + matrixPadding * 2 + cardPadding * 2;
  const logoOuter = Math.round(size * 0.24);
  const logoFrame = 5;
  const innerLogo = logoOuter - logoFrame * 2;

  return (
    <div className="flex flex-col items-center">
      {caption && (
        <p className="mb-3 text-center text-xs uppercase tracking-wider text-tg-hint">
          {caption}
        </p>
      )}

      <div
        className={pulse ? 'qr-pulse' : undefined}
        style={{
          width: cardSize,
          height: cardSize,
          padding: cardPadding,
          borderRadius: 28,
          background: cardBg,
          boxShadow: cardShadow,
        }}
      >
        <div
          className="relative flex items-center justify-center"
          style={{
            width: '100%',
            height: '100%',
            borderRadius: 24,
            background: matrixBg,
            padding: matrixPadding,
            boxSizing: 'border-box',
          }}
        >
          {svgPaths ? (
            <svg
              width={size}
              height={size}
              viewBox={`0 0 ${size} ${size}`}
              role="img"
              aria-label="payment QR code"
              style={{ display: 'block' }}
            >
              <rect width={size} height={size} fill={matrixBg} />
              <g
                fill={moduleColor}
                dangerouslySetInnerHTML={{ __html: svgPaths.dots }}
              />
              <g dangerouslySetInnerHTML={{ __html: svgPaths.finders }} />
            </svg>
          ) : (
            <div
              style={{ width: size, height: size }}
              className="flex items-center justify-center text-xs text-tg-destructive-text"
            >
              QR error
            </div>
          )}

          {network && svgPaths && (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: logoOuter,
                height: logoOuter,
                // Outer plate is the matrix background (white) so the
                // QR modules under the logo visually disappear; the
                // overlap is well within the H-level ECC budget.
                background: matrixBg,
                borderRadius: '9999px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: `0 6px 20px -6px ${moduleColor}55`,
              }}
            >
              <div
                style={{
                  width: innerLogo,
                  height: innerLogo,
                  // Brand-gradient ring effect via border + radial bg.
                  borderRadius: '9999px',
                  background: NETWORK_GRADIENT[network],
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: `inset 0 0 0 2px rgba(255,255,255,0.18), 0 4px 12px -2px rgba(0,0,0,0.28)`,
                }}
              >
                <NetworkIcon
                  network={network}
                  size={Math.round(innerLogo * 0.6)}
                  variant="mono"
                  color="#FFFFFF"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {network && token && token !== 'native' && (
        <div
          className="mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium"
          style={{ background: `${TOKEN_TINT[token]}1a`, color: TOKEN_TINT[token] }}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: TOKEN_TINT[token] }}
            aria-hidden
          />
          {token} · {NETWORK_LABEL[network]}
        </div>
      )}
    </div>
  );
}
