/** Browser: download the .xlsx straight away. */
import { buildXlsx, XLSX_MIME, type Sheet } from './xlsx';

export async function exportXlsx(fileName: string, sheets: Sheet[]): Promise<void> {
  const bytes = buildXlsx(sheets);
  const blob = new Blob([bytes as unknown as BlobPart], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
