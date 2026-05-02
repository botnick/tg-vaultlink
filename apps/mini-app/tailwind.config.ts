import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        th: ['"IBM Plex Sans Thai"', 'system-ui', 'sans-serif'],
        en: ['Roboto', 'system-ui', 'sans-serif'],
      },
      colors: {
        tg: {
          bg: 'var(--tg-bg)',
          text: 'var(--tg-text)',
          hint: 'var(--tg-hint)',
          link: 'var(--tg-link)',
          button: 'var(--tg-button)',
          'button-text': 'var(--tg-button-text)',
          'secondary-bg': 'var(--tg-secondary-bg)',
          'section-bg': 'var(--tg-section-bg)',
          'header-bg': 'var(--tg-header-bg)',
          'accent-text': 'var(--tg-accent-text)',
          'destructive-text': 'var(--tg-destructive-text)',
          'subtitle-text': 'var(--tg-subtitle-text)',
        },
        // Brand gradient stops — used for hero cards, primary buttons,
        // and accent glows. Layered ON TOP of the Telegram theme so the
        // surface adapts but the accent stays branded.
        brand: {
          violet: '#8B5CF6',
          indigo: '#6366F1',
          fuchsia: '#D946EF',
          pink: '#EC4899',
          cyan: '#06B6D4',
          teal: '#14B8A6',
          amber: '#F59E0B',
        },
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
      backgroundImage: {
        // Multi-stop fintech gradients for hero surfaces.
        'gradient-hero': 'linear-gradient(135deg, #6366F1 0%, #8B5CF6 45%, #EC4899 100%)',
        'gradient-mint': 'linear-gradient(135deg, #06B6D4 0%, #14B8A6 100%)',
        'gradient-sunset': 'linear-gradient(135deg, #F59E0B 0%, #EC4899 100%)',
        // Aurora-mesh: three radial gradients that drift slowly.
        'gradient-aurora':
          'radial-gradient(at 20% 0%, rgba(99,102,241,0.55) 0%, transparent 50%), radial-gradient(at 80% 100%, rgba(236,72,153,0.5) 0%, transparent 55%), radial-gradient(at 50% 50%, rgba(6,182,212,0.4) 0%, transparent 60%)',
        // Shine sweep used by buttons / hero highlights.
        shine:
          'linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.35) 50%, transparent 70%)',
      },
      boxShadow: {
        glow: '0 10px 40px -12px rgba(99, 102, 241, 0.45)',
        'glow-pink': '0 10px 40px -12px rgba(236, 72, 153, 0.45)',
        'glow-cyan': '0 10px 40px -12px rgba(6, 182, 212, 0.45)',
        soft: '0 1px 2px rgba(0,0,0,0.04), 0 8px 24px -8px rgba(0,0,0,0.10)',
        'soft-lg': '0 2px 4px rgba(0,0,0,0.06), 0 16px 40px -12px rgba(0,0,0,0.18)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' },
        },
        // Slow drift on hero gradients for a "live" feel.
        'aurora-drift': {
          '0%, 100%': { backgroundPosition: '0% 0%, 100% 100%, 50% 50%' },
          '50%': { backgroundPosition: '100% 25%, 0% 75%, 75% 25%' },
        },
        // One-shot shine sweep across primary buttons.
        'shine-sweep': {
          '0%': { transform: 'translateX(-120%)' },
          '60%, 100%': { transform: 'translateX(220%)' },
        },
        'soft-pulse': {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.85' },
          '50%': { transform: 'scale(1.06)', opacity: '1' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 220ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-in': 'fade-in 200ms ease-out both',
        shimmer: 'shimmer 1.4s linear infinite',
        'aurora-drift': 'aurora-drift 14s ease-in-out infinite',
        'shine-sweep': 'shine-sweep 1.6s ease-in-out infinite',
        'soft-pulse': 'soft-pulse 2.4s ease-in-out infinite',
        float: 'float 3.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
