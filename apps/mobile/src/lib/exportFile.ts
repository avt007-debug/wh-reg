/** Phones: write the .xlsx to the cache folder and open the share sheet (WhatsApp, Drive, Excel…). */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { buildXlsx, XLSX_MIME, type Sheet } from './xlsx';

export async function exportXlsx(fileName: string, sheets: Sheet[]): Promise<void> {
  const f = new File(Paths.cache, fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`);
  if (f.exists) f.delete();
  f.create();
  f.write(buildXlsx(sheets));
  await Sharing.shareAsync(f.uri, { mimeType: XLSX_MIME, UTI: 'org.openxmlformats.spreadsheetml.sheet', dialogTitle: 'Export to Excel' });
}
