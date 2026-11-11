/** SALES bill entry for staff — see src/components/BillForm. */
import { BillForm } from '../../src/components/BillForm';
import { ClockBanner } from '../../src/components/ClockBanner';
import { Screen } from '../../src/components/ui';

export default function Outward() {
  return (
    <Screen>
      <ClockBanner />
      <BillForm kind="sale" />
    </Screen>
  );
}
