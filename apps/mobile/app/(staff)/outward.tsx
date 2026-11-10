/**
 * OUTWARD (Sales bill) entry for staff — see src/components/SalesEntryForm.
 * Every item carries its GST %; 0 % lines count as Non-GST billed.
 */
import { Screen } from '../../src/components/ui';
import { SalesEntryForm } from '../../src/components/SalesEntryForm';
import { ClockBanner } from '../../src/components/ClockBanner';

export default function Outward() {
  return (
    <Screen>
      <ClockBanner />
      <SalesEntryForm />
    </Screen>
  );
}
