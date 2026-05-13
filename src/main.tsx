import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './app/routes';
// Chessground stylesheets first so our index.css can override the
// coordinate-label positioning rules without needing `!important`.
// (Default chessground positions the ranks column at `top: -20px`
// and the files row at `bottom: -4px`, both outside the board frame
// — we move them inside, chess.com-style, in `index.css`.)
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './styles/index.css';
// i18n init runs at module load: imports the catalogs and configures
// language detection. Imported for side effects only — components use
// the `useTranslation()` hook from `react-i18next` directly. Placed
// after `index.css` so the very first React render has translations
// ready and we don't ship a default-language flash.
import './i18n';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
