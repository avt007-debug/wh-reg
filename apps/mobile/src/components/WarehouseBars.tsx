/**
 * Revenue trend, one bar group per period, one colour per warehouse.
 * Accessibility: colour follows the warehouse (fixed order), a legend is always
 * present, and the exact values are listed in a table under the chart so no
 * value is carried by colour alone.
 */
import { Text, View } from 'react-native';
import { BarChart } from 'react-native-gifted-charts';
import { formatINR } from '@wh/shared';
import { seriesColor, useTheme } from '../theme';
import { Row } from './ui';

export interface TrendPoint { bucket: string; warehouse_code: string; revenue_excl_gst: number }

const compact = (n: number) => (n >= 1e7 ? `${(n / 1e7).toFixed(1)}Cr` : n >= 1e5 ? `${(n / 1e5).toFixed(1)}L` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

export function WarehouseBars({ points, warehouses, buckets: fixed, formatBucket = (b) => b.slice(5), formatAxis, names = {}, colorCodes, showTotal = true }: {
  points: TrendPoint[]; warehouses: string[];
  /** code → display name for the legend, e.g. { CTR: 'Chittoor' } */
  names?: Record<string, string>;
  /** short x-axis label (defaults to formatBucket) */
  formatAxis?: (bucket: string) => string;
  /** every warehouse code, so a warehouse keeps its colour when the chart shows only some */
  colorCodes?: string[];
  /** false when the series should not be added up (e.g. sales vs collected) */
  showTotal?: boolean;
  /** Show these periods even when they have no sales (e.g. the last 12 months). */
  buckets?: string[]; formatBucket?: (bucket: string) => string;
}) {
  const t = useTheme();
  const buckets = fixed ?? [...new Set(points.map((p) => p.bucket))].sort();
  const palette = colorCodes ?? warehouses;
  const barWidth = warehouses.length > 1 ? 14 : 22;
  const gap = warehouses.length > 1 ? 18 : 14;
  const groupWidth = warehouses.length * barWidth + (warehouses.length - 1) * 2;
  const axis = formatAxis ?? formatBucket;
  const data = buckets.flatMap((b, bi) =>
    warehouses.map((w, wi) => {
      const v = points.find((p) => p.bucket === b && p.warehouse_code === w)?.revenue_excl_gst ?? 0;
      return {
        value: v,
        frontColor: seriesColor(t, palette, w),
        spacing: wi === warehouses.length - 1 ? gap : 2,     // 2px gap inside a group
        label: wi === 0 ? axis(b) : undefined,
        labelWidth: groupWidth + gap,
        labelTextStyle: { color: t.textMuted, fontSize: 10 },
        key: `${bi}-${w}`,
      };
    }));

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 14, flexWrap: 'wrap' }}>
        {warehouses.map((w) => (
          <View key={w} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: seriesColor(t, palette, w) }} />
            <Text style={{ color: t.textSecondary }}>{names[w] ?? w}</Text>
          </View>
        ))}
      </View>
      <BarChart
        key={`${warehouses.join(',')}|${buckets.length}|${points.length}`}  // remount on switch: animated bars otherwise keep stale heights
        data={data}
        barWidth={barWidth}
        barBorderTopLeftRadius={4}
        barBorderTopRightRadius={4}
        noOfSections={4}
        yAxisThickness={0}
        xAxisColor={t.border}
        rulesColor={t.border}
        rulesType="solid"
        yAxisTextStyle={{ color: t.textMuted, fontSize: 10 }}
        formatYLabel={(l) => compact(Number(l))}
        isAnimated
        renderTooltip={(item: { value: number }) => (
          <View style={{ backgroundColor: t.card, borderColor: t.border, borderWidth: 1, padding: 6, borderRadius: 6 }}>
            <Text style={{ color: t.text, fontSize: 12 }}>{formatINR(item.value)}</Text>
          </View>
        )}
      />
      {buckets.slice(-6).reverse().map((b) => (
        <Row key={b} left={formatBucket(b)}
          right={showTotal ? formatINR(points.filter((p) => p.bucket === b).reduce((a, p) => a + p.revenue_excl_gst, 0)) : undefined}
          sub={warehouses.map((w) => `${names[w] ?? w} ${compact(points.find((p) => p.bucket === b && p.warehouse_code === w)?.revenue_excl_gst ?? 0)}`).join(' · ')} />
      ))}
    </View>
  );
}
