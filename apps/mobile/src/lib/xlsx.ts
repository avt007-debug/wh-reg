/**
 * Tiny Excel (.xlsx) writer — enough for clean exports: several sheets, a bold
 * frozen header row with filters, column widths, and real numbers (so Excel
 * can sum / sort them). No external spreadsheet library; zipped with fflate.
 */
import { strToU8, zipSync } from 'fflate';

export type CellKind = 'text' | 'number' | 'money' | 'date';
export interface Column { header: string; kind?: CellKind; width?: number }
export type Cell = string | number | null | undefined;
export interface Sheet { name: string; columns: Column[]; rows: Cell[][] }

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
   // strip characters XML 1.0 does not allow
   .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const colName = (i: number) => {
  let n = i + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

// Excel serial date (days since 1899-12-30) for an ISO yyyy-mm-dd string.
const excelDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return (Date.UTC(y!, m! - 1, d!) - Date.UTC(1899, 11, 30)) / 86400000;
};

// style ids in styles.xml: 0 default, 1 bold header, 2 money #,##0.00, 3 number #,##0.###, 4 date dd-mm-yyyy
const STYLE: Record<CellKind, number> = { text: 0, money: 2, number: 3, date: 4 };

function sheetXml(sh: Sheet): string {
  const cols = sh.columns.map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? Math.max(10, Math.min(48, c.header.length + 4))}" customWidth="1"/>`).join('');
  const header = `<row r="1">${sh.columns.map((c, i) =>
    `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t>${esc(c.header)}</t></is></c>`).join('')}</row>`;
  const body = sh.rows.map((row, ri) => {
    const r = ri + 2;
    const cells = row.map((v, ci) => {
      if (v === null || v === undefined || v === '') return '';
      const ref = `${colName(ci)}${r}`;
      const kind = sh.columns[ci]?.kind ?? 'text';
      if (kind === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return `<c r="${ref}" s="4"><v>${excelDate(v)}</v></c>`;
      if (kind !== 'text' && typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${STYLE[kind]}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
    }).join('');
    return `<row r="${r}">${cells}</row>`;
  }).join('');
  const last = `${colName(Math.max(sh.columns.length - 1, 0))}${sh.rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols><sheetData>${header}${body}</sheetData>${sh.rows.length ? `<autoFilter ref="A1:${last}"/>` : ''}</worksheet>`;
}

const safeSheetName = (n: string, i: number) => (n.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`);

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const names = sheets.map((s, i) => safeSheetName(s.name, i));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.###"/><numFmt numFmtId="166" formatCode="dd-mm-yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s)); });
  return zipSync(files, { level: 6 });
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
