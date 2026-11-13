/** Print / PDF, WhatsApp to the customer, and e-way bill / e-invoice files for one sales bill. */
import { rpc } from '../api/client';
import { askText, notify } from '../lib/dialogs';
import { printHtml, saveTextFile } from '../lib/download';
import { einvoiceJson, ewayJson, invoiceHtml, invoiceWhatsAppText, portalProblems, type InvoiceData } from '../lib/invoice';
import { openWhatsApp } from '../lib/whatsapp';
import { SmallButton, Toolbar } from './ui';

const load = (id: string) => rpc<InvoiceData>('invoice_data', { p_dispatch: id });
const fail = (e: unknown) => notify('Could not open the bill', e instanceof Error ? e.message : String(e));
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-');

export function InvoiceActions({ dispatchId, gst = false }: { dispatchId: string; gst?: boolean }) {
  const print = () => load(dispatchId).then((d) => {
    if (!printHtml(invoiceHtml(d))) notify('Allow pop-ups', 'Your browser blocked the print window. Allow pop-ups for this site and try again.');
  }, fail);
  const whatsapp = () => load(dispatchId).then((d) => {
    if (!d.buyer?.phone) notify('No phone number for this customer', 'WhatsApp will open so you can pick the contact. Add the number on the Customers page to skip this next time.');
    void openWhatsApp(d.buyer?.phone, invoiceWhatsAppText(d));
  }, fail);
  const portal = async (kind: 'eway' | 'einvoice') => {
    try {
      const d = await load(dispatchId);
      const p = portalProblems(d, kind);
      if (p.length) { notify('Fix these first', p.map((x) => `• ${x}`).join('\n')); return; }
      if (kind === 'eway') {
        const km = Number((await askText('Distance (km)', 'Approximate road distance from the warehouse to the customer, as the portal asks:'))?.trim());
        if (!Number.isFinite(km) || km <= 0 || km > 4000) return;
        await saveTextFile(`EWB_${safe(d.bill.invoice_no)}.json`, JSON.stringify(ewayJson(d, km), null, 2));
        notify('E-way bill file saved', 'On ewaybillgst.gov.in → e-Way Bill → Generate Bulk, upload this file. Check the details before you submit.');
      } else {
        await saveTextFile(`EINV_${safe(d.bill.invoice_no)}.json`, JSON.stringify(einvoiceJson(d), null, 2));
        notify('E-invoice file saved', 'Upload it on the e-invoice portal (einvoice1.gst.gov.in → e-Invoice → Bulk upload) to get the IRN. Check before you submit.');
      }
    } catch (e) { fail(e); }
  };
  return (
    <Toolbar>
      <SmallButton icon="print-outline" title="Print / PDF" onPress={() => void print()} />
      <SmallButton icon="logo-whatsapp" title="WhatsApp bill" onPress={() => void whatsapp()} />
      {gst ? <SmallButton icon="car-outline" title="E-way bill file" onPress={() => void portal('eway')} /> : null}
      {gst ? <SmallButton icon="document-attach-outline" title="E-invoice file" onPress={() => void portal('einvoice')} /> : null}
    </Toolbar>
  );
}
