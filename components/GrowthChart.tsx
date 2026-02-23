// components/GrowthChart.tsx
// Follower count line chart — 7-day or 30-day view.
// Requires react-native-svg (included as dependency).

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import Svg, { Path, Defs, LinearGradient, Stop, Circle, Line as SvgLine, Text as SvgText } from 'react-native-svg';
import { useSnapshotHistory } from '@/hooks/useSnapshotHistory';
import C from '@/lib/colors';

const WINDOW_WIDTH = Dimensions.get('window').width;
const CHART_W      = WINDOW_WIDTH - 32 - 2; // 16px frame padding each side
const CHART_H      = 140;
const PAD          = { top: 16, bottom: 40, left: 44, right: 12 };
const INNER_W      = CHART_W - PAD.left - PAD.right;
const INNER_H      = CHART_H - PAD.top  - PAD.bottom;

function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const cpx = (pts[i - 1].x + pts[i].x) / 2;
    d += ` C ${cpx} ${pts[i - 1].y} ${cpx} ${pts[i].y} ${pts[i].x} ${pts[i].y}`;
  }
  return d;
}

function areaPath(pts: { x: number; y: number }[], baseY: number): string {
  if (pts.length === 0) return '';
  const line = smoothPath(pts);
  return `${line} L ${pts[pts.length - 1].x} ${baseY} L ${pts[0].x} ${baseY} Z`;
}

function fmtDate(iso: string, short = false): string {
  const d = new Date(iso);
  return short
    ? d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })
    : d.toLocaleDateString('en-US', { month: 'short',   day: 'numeric' });
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function GrowthChart() {
  const [days, setDays] = useState<7 | 30>(7);
  const { data: snaps, isLoading } = useSnapshotHistory(days);

  // Normalise to chart coordinates
  const pts = snaps && snaps.length > 0
    ? (() => {
        const counts  = snaps.map(s => s.follower_count);
        const minY    = Math.min(...counts);
        const maxY    = Math.max(...counts);
        const rangeY  = maxY - minY || 1;
        const firstTs = new Date(snaps[0].captured_at).getTime();
        const lastTs  = new Date(snaps[snaps.length - 1].captured_at).getTime();
        const rangeX  = lastTs - firstTs || 1;

        return snaps.map(s => ({
          x: PAD.left + ((new Date(s.captured_at).getTime() - firstTs) / rangeX) * INNER_W,
          y: PAD.top  + INNER_H - ((s.follower_count - minY) / rangeY) * INNER_H,
          count: s.follower_count,
          date:  s.captured_at,
        }));
      })()
    : [];

  const minVal  = snaps?.length ? Math.min(...snaps.map(s => s.follower_count)) : 0;
  const maxVal  = snaps?.length ? Math.max(...snaps.map(s => s.follower_count)) : 0;
  const baseY   = PAD.top + INNER_H;

  // X labels: first, middle ± last
  const xLabels = pts.length >= 3
    ? [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]]
    : pts;

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Follower Growth</Text>
        <View style={styles.toggleRow}>
          {([7, 30] as const).map(d => (
            <TouchableOpacity
              key={d}
              style={[styles.toggleBtn, days === d && styles.toggleActive]}
              onPress={() => setDays(d)}
            >
              <Text style={[styles.toggleText, days === d && styles.toggleTextActive]}>
                {d}d
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Chart body */}
      {isLoading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : !snaps || snaps.length < 2 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>Not enough data yet</Text>
          <Text style={styles.emptySubtext}>Snapshots will populate this chart</Text>
        </View>
      ) : (
        <Svg width={CHART_W} height={CHART_H}>
          <Defs>
            <LinearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0"   stopColor={C.accent} stopOpacity="0.35" />
              <Stop offset="1"   stopColor={C.accent} stopOpacity="0"    />
            </LinearGradient>
          </Defs>

          {/* Horizontal grid lines + y-axis labels */}
          {[0, 0.5, 1].map(f => {
            const y = PAD.top + f * INNER_H;
            const v = maxVal - f * (maxVal - minVal);
            return (
              <React.Fragment key={f}>
                <SvgLine
                  x1={PAD.left} y1={y} x2={PAD.left + INNER_W} y2={y}
                  stroke={C.border} strokeWidth="1" opacity="0.6"
                />
                <SvgText
                  x={PAD.left - 4}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="9"
                  fill={C.textMuted}
                >
                  {fmtCount(Math.round(v))}
                </SvgText>
              </React.Fragment>
            );
          })}

          {/* Area fill */}
          {pts.length >= 2 && (
            <Path d={areaPath(pts, baseY)} fill="url(#areaGrad)" />
          )}

          {/* Line */}
          {pts.length >= 2 && (
            <Path
              d={smoothPath(pts)}
              fill="none"
              stroke={C.accent}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* Single point fallback */}
          {pts.length === 1 && (
            <Circle cx={pts[0].x} cy={pts[0].y} r={4} fill={C.accent} />
          )}

          {/* End dot */}
          {pts.length >= 1 && (
            <Circle
              cx={pts[pts.length - 1].x}
              cy={pts[pts.length - 1].y}
              r={4}
              fill={C.accent}
            />
          )}
        </Svg>
      )}

      {/* X-axis date labels */}
      {!isLoading && pts.length >= 2 && (
        <View style={[styles.xAxisRow, { width: CHART_W, paddingLeft: PAD.left, paddingRight: PAD.right }]}>
          {xLabels.map((p, i) => (
            <Text
              key={i}
              style={[
                styles.xLabel,
                i === 0               && { textAlign: 'left' },
                i === xLabels.length - 1 && { textAlign: 'right' },
                i > 0 && i < xLabels.length - 1 && { textAlign: 'center', flex: 1 },
              ]}
            >
              {fmtDate(p.date, true)}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderRadius:    14,
    padding:         16,
    marginBottom:    14,
    overflow:        'hidden',
  },
  header: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
    marginBottom:   12,
  },
  title: {
    color:      C.textSecondary,
    fontSize:   13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  toggleRow: {
    flexDirection: 'row',
    gap:           4,
  },
  toggleBtn: {
    paddingHorizontal: 10,
    paddingVertical:    4,
    borderRadius:       8,
    backgroundColor:   C.surfaceAlt,
  },
  toggleActive: {
    backgroundColor: C.accent,
  },
  toggleText: {
    color:    C.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  toggleTextActive: {
    color: '#fff',
  },
  loadingBox: {
    height:         CHART_H,
    alignItems:    'center',
    justifyContent: 'center',
  },
  emptyBox: {
    height:         CHART_H - 20,
    alignItems:    'center',
    justifyContent: 'center',
    gap:            4,
  },
  emptyText: {
    color:    C.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  emptySubtext: {
    color:    C.textMuted,
    fontSize: 12,
  },
  xAxisRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop:      -24,
  },
  xLabel: {
    color:    C.textMuted,
    fontSize: 10,
    minWidth: 50,
  },
});
