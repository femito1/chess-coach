import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MoveEval } from '@/db/schema';

interface Point {
  ply: number;
  eval: number;
  san: string;
  classification: MoveEval['classification'];
}

export interface EvalGraphProps {
  moves: MoveEval[];
  currentPly: number;
  onJump: (ply: number) => void;
}

export function EvalGraph({ moves, currentPly, onJump }: EvalGraphProps) {
  const { t } = useTranslation();
  const data = useMemo<Point[]>(() => {
    return moves.map((m) => ({
      ply: m.ply,
      // Clamp so that absurd mates don't dominate the axis.
      eval: Math.max(-10, Math.min(10, m.evalCpAfter / 100)),
      san: m.san,
      classification: m.classification,
    }));
  }, [moves]);

  const markers = data.filter(
    (p) =>
      p.classification === 'blunder' ||
      p.classification === 'mistake' ||
      p.classification === 'miss',
  );

  return (
    <div className="w-full h-44 card p-2">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
          onClick={(e: unknown) => {
            const payload = e as { activeLabel?: number } | undefined;
            if (payload?.activeLabel != null) onJump(Number(payload.activeLabel));
          }}
        >
          <defs>
            <linearGradient id="evalFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#7aa2f7" stopOpacity={0.5} />
              <stop offset="50%" stopColor="#7aa2f7" stopOpacity={0.05} />
              <stop offset="100%" stopColor="#e06c75" stopOpacity={0.3} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a313d" />
          <XAxis
            dataKey="ply"
            stroke="#9aa3b2"
            tickFormatter={(p) => Math.ceil(Number(p) / 2).toString()}
            fontSize={10}
          />
          <YAxis
            domain={[-10, 10]}
            stroke="#9aa3b2"
            width={28}
            fontSize={10}
            ticks={[-10, -5, 0, 5, 10]}
          />
          <Tooltip
            contentStyle={{ background: '#161a22', border: '1px solid #2a313d', fontSize: 12 }}
            labelFormatter={(p) => `${t('review.evalGraphLabels.tooltipMove')} ${Math.ceil(Number(p) / 2)}${Number(p) % 2 === 1 ? '' : '…'}`}
            formatter={(val: number, _name, item: { payload?: Point }) => [
              `${val > 0 ? '+' : ''}${val.toFixed(2)} (${item.payload?.san ?? ''})`,
              t('review.evalGraphLabels.tooltipEval'),
            ]}
          />
          <ReferenceLine y={0} stroke="#2a313d" />
          <ReferenceLine x={currentPly} stroke="#7aa2f7" strokeDasharray="3 3" />
          {markers.map((m) => (
            <ReferenceLine
              key={m.ply}
              x={m.ply}
              stroke={
                m.classification === 'blunder'
                  ? '#e06c75'
                  : m.classification === 'miss'
                    ? '#c678dd'
                    : '#e69138'
              }
              strokeOpacity={0.5}
            />
          ))}
          <Area type="monotone" dataKey="eval" stroke="#7aa2f7" fill="url(#evalFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
