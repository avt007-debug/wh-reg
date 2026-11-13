/** Minimal .xlsx / .csv reader (no extra app needed): sheet names and rows of cell text. */
import { strFromU8, unzipSync } from 'fflate';

export interface Book { sheets: { name: string; rows: string[][] }[] }
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');
const colIndex = (ref: string) => { const letters = ref.replace(/\d+/g, ''); let n = 0; for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };

export function readXlsx(bytes: Uint8Array): Book {
  const files = unzipSync(bytes);
  const text = (p: string) => (files[p] ? strFromU8(files[p]!) : '');
  const shared: string[] = [];
  for (const si of text('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) ?? []) {
    shared.push(unxml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<t[^>]*>|<\/t>/g, '')).join('')));
  }
  const rels = new Map<string, string>();
  for (const r of text('xl/_rels/workbook.xml.rels').match(/<Relationship [^>]*>/g) ?? []) {
    const id = r.match(/Id="([^"]+)"/)?.[1]; const target = r.match(/Target="([^"]+)"/)?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
  }
  const sheets: Book['sheets'] = [];
  for (const s of text('xl/workbook.xml').match(/<sheet [^>]*>/g) ?? []) {
    const name = unxml(s.match(/name="([^"]+)"/)?.[1] ?? 'Sheet');
    const rid = s.match(/r:id="([^"]+)"/)?.[1] ?? '';
    const xml = text(rels.get(rid) ?? '');
    const rows: string[][] = [];
    for (const row of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const out: string[] = [];
      for (const c of row.match(/<c [^>]*?(\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = c.match(/r="([A-Z]+\d+)"/)?.[1]; const type = c.match(/t="([^"]+)"/)?.[1];
        let v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
        if (type === 's') v = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') v = (c.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '');
        out[ref ? colIndex(ref) : out.length] = unxml(v).trim();
      }
      rows.push(Array.from(out, (x) => x ?? ''));
    }
    sheets.push({ name, rows });
  }
  return { sheets };
}

export function readCsv(text: string): Book {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cell.trim()); cell = ''; } else if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return { sheets: [{ name: 'CSV', rows }] };
}

/** Opens the file chooser (browser) and reads the picked .xlsx or .csv. */
export function pickSpreadsheet(): Promise<{ name: string; book: Book } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';
    input.onchange = async () => {
      const f = input.files?.[0]; if (!f) { resolve(null); return; }
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        resolve({ name: f.name, book: /\.csv$/i.test(f.name) ? readCsv(new TextDecoder().decode(buf)) : readXlsx(buf) });
      } catch { resolve(null); }
    };
    input.click();
  });
}
