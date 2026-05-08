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
        // Light-brown for "book" / theory moves, mirroring chess.com's
        // book badge colour. Used by the on-board badge background
        // (`Board.tsx`), the inline glyph in the move list
        // (`MoveList.tsx`), and any future surface that needs to mark
        // a move as theory (currently none, but kept centralised so
        // the colour stays in sync).
        book: '#a88865',
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
