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

export function WarehouseBars({ points, warehouses }: { points: TrendPoint[]; warehouses: string[] }) {
  const t = useTheme();
  const buckets = [...new Set(points.map((p) => p.bucket))].sort();
  const data = buckets.flatMap((b, bi) =>
    warehouses.map((w, wi) => {
      const v = points.find((p) => p.bucket === b && p.warehouse_code === w)?.revenue_excl_gst ?? 0;
      return {
        value: v,
        frontColor: seriesColor(t, warehouses, w),
        spacing: wi === warehouses.length - 1 ? 18 : 2,     // 2px gap inside a group
        label: wi === 0 ? b.slice(5) : undefined,
        labelTextStyle: { color: t.textMuted, fontSize: 10 },
        key: `${bi}-${w}`,
      };
    }));

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 14, flexWrap: 'wrap' }}>
        {warehouses.map((w) => (
          <View key={w} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: seriesColor(t, warehouses, w) }} />
            <Text style={{ color: t.textSecondary }}>{w}</Text>
          </View>
        ))}
      </View>
      <BarChart
        data={data}
        barWidth={14}
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
        <Row key={b} left={b}
          right={formatINR(points.filter((p) => p.bucket === b).reduce((a, p) => a + p.revenue_excl_gst, 0))}
          sub={warehouses.map((w) => `${w} ${compact(points.find((p) => p.bucket === b && p.warehouse_code === w)?.revenue_excl_gst ?? 0)}`).join(' · ')} />
      ))}
    </View>
  );
}
