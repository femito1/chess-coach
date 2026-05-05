import { createHashRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { ImportPage } from '@/features/import/ImportPage';
import { GamesPage } from '@/features/games/GamesPage';
import { ReviewPage } from '@/features/review/ReviewPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { WeaknessesPage } from '@/features/weaknesses/WeaknessesPage';
import { PuzzlesPage } from '@/features/puzzles/PuzzlesPage';
import { RepertoirePage } from '@/features/repertoire/RepertoirePage';
import { RepertoireEditor } from '@/features/repertoire/RepertoireEditor';
import { RepertoireTrainer } from '@/features/repertoire/RepertoireTrainer';
import { RepertoireLineTrainer } from '@/features/repertoire/RepertoireLineTrainer';
import { LibraryPage } from '@/features/openings/LibraryPage';
import { BackupPage } from '@/features/backup/BackupPage';

export const router = createHashRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'import', element: <ImportPage /> },
      { path: 'games', element: <GamesPage /> },
      { path: 'review/:id', element: <ReviewPage /> },
      { path: 'weaknesses', element: <WeaknessesPage /> },
      { path: 'puzzles', element: <PuzzlesPage /> },
      { path: 'repertoire', element: <RepertoirePage /> },
      { path: 'repertoire/:id', element: <RepertoireEditor /> },
      { path: 'repertoire/:id/train', element: <RepertoireTrainer /> },
      { path: 'repertoire/:id/lines', element: <RepertoireLineTrainer /> },
      { path: 'openings', element: <LibraryPage /> },
      { path: 'backup', element: <BackupPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);
