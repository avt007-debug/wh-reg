import { Card, Chips } from './ui';
import { SIZES, useTextSize } from '../lib/textSize';

/** Normal / Large / Extra large text for this phone. */
export function TextSize() {
  const { scale, set } = useTextSize();
  return (
    <Card title="Text size" icon="text-outline" subtitle="Makes everything bigger on this phone. Pick what is easiest to read.">
      <Chips options={[...SIZES]} value={scale} onChange={set} format={(v) => (v === 1 ? 'Normal' : v === 1.15 ? 'Large' : 'Extra large')} />
    </Card>
  );
}
