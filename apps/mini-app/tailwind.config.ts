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
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
    },
  },
  plugins: [],
} satisfies Config;
