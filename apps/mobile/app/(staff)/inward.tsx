/**
 * PURCHASE (inward) entry for staff — same fields as a sales bill. It goes to
 * the owner for approval; stock is added once approved. See src/components/BillForm.
 */
import { BillForm } from '../../src/components/BillForm';
import { Screen } from '../../src/components/ui';

export default function Inward() {
  return (
    <Screen>
      <BillForm kind="purchase" />
    </Screen>
  );
}
