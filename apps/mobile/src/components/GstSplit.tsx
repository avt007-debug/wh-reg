/** GST-billed (GST % > 0) vs Non-GST-billed (0 %) — badge for a line and a summary card. */
import { Text, View } from 'react-native';
import { formatINR, type GstBucket } from '@wh/shared';
import { useTheme } from '../theme';
import { Row } from './ui';

export function GstTag({ rate }: { rate: number | string }) {
  const t = useTheme();
  const gst = Number(rate) > 0;
  return (
    <View style={{ alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
      backgroundColor: gst ? t.accent : t.border }}>
      <Text style={{ color: gst ? '#fff' : t.text, fontSize: 11, fontWeight: '700' }}>{gst ? `GST billed · ${Number(rate)}%` : 'Non-GST · 0%'}</Text>
    </View>
  );
}

export function GstSplitRows({ gst, nonGst }: { gst: GstBucket; nonGst: GstBucket }) {
  return (
    <>
      <Row left="GST billed" sub={`${gst.lines} line(s) · taxable ${formatINR(gst.taxable)} + GST ${formatINR(gst.tax)}`} right={formatINR(gst.total)} />
      <Row left="Non-GST billed" sub={`${nonGst.lines} line(s) at 0% GST`} right={formatINR(nonGst.total)} />
    </>
  );
}
