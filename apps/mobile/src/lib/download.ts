/** Save a text file (JSON for the GST portal, etc.). Browser: downloads it; phone app: share sheet. */
import { Platform } from 'react-native';

export async function saveTextFile(fileName: string, text: string, mime = 'application/json') {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const f = new File(Paths.cache, fileName);
  if (f.exists) f.delete();
  f.create(); f.write(text);
  await Sharing.shareAsync(f.uri, { mimeType: mime, dialogTitle: fileName });
}

/** Opens a printable page in a new tab and starts printing (the browser offers "Save as PDF"). */
export function printHtml(html: string) {
  if (Platform.OS !== 'web') return false;
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open(); w.document.write(html); w.document.close();
  w.focus();
  setTimeout(() => w.print(), 400);
  return true;
}
