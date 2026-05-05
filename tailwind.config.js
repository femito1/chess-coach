/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0f1115',
          soft: '#161a22',
          raised: '#1e242f',
        },
        border: {
          DEFAULT: '#2a313d',
        },
        text: {
          DEFAULT: '#e6e8eb',
          muted: '#9aa3b2',
        },
        accent: {
          DEFAULT: '#7aa2f7',
        },
        good: '#7bc47f',
        brilliant: '#26c2a3',
        excellent: '#7bc47f',
        inaccuracy: '#f0c36d',
        miss: '#c678dd',
        mistake: '#e69138',
        blunder: '#e06c75',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
