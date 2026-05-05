const BASE = 'https://api.chess.com';

export interface ChessComArchivesResponse {
  archives: string[];
}

export interface ChessComPlayer {
  username: string;
  rating?: number;
  result: string;
  '@id': string;
  uuid?: string;
}

export interface ChessComGame {
  url: string;
  pgn: string;
  time_control: string;
  time_class: 'bullet' | 'blitz' | 'rapid' | 'daily';
  end_time: number;
  rated: boolean;
  fen: string;
  white: ChessComPlayer;
  black: ChessComPlayer;
  eco?: string;
  opening?: string;
  rules?: string;
  accuracies?: { white: number; black: number };
}

export interface ChessComMonth {
  games: ChessComGame[];
}

async function jsonGet<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Chess.com API ${res.status} on ${url}`);
  }
  return (await res.json()) as T;
}

export async function fetchArchives(username: string): Promise<string[]> {
  const { archives } = await jsonGet<ChessComArchivesResponse>(
    `${BASE}/pub/player/${encodeURIComponent(username)}/games/archives`,
  );
  return archives;
}

export async function fetchMonth(archiveUrl: string): Promise<ChessComGame[]> {
  const { games } = await jsonGet<ChessComMonth>(archiveUrl);
  return games;
}

export function parseArchiveUrl(url: string): { year: number; month: number } | null {
  const m = url.match(/\/(\d{4})\/(\d{2})$/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

export function formatMonth(year: number, month: number): string {
  const names = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${names[month - 1]} ${year}`;
}
