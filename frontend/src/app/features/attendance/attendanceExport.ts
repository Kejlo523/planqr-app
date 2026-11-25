import { attendanceStatusLabel, type AttendanceDraft } from "./attendanceDrafts";

interface ZipSourceFile {
  name: string;
  content: string;
}

interface PreparedZipFile {
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const encoder = new TextEncoder();

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

const encodeUtf8 = (value: string) => encoder.encode(value);

const concatUint8Arrays = (parts: Uint8Array[]) => {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
};

const calculateCrc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
};

const getDosTimestamp = () => {
  const date = new Date();
  const year = Math.max(1980, date.getFullYear());

  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

const writeUint16 = (view: DataView, offset: number, value: number) => {
  view.setUint16(offset, value, true);
};

const writeUint32 = (view: DataView, offset: number, value: number) => {
  view.setUint32(offset, value >>> 0, true);
};

const createLocalFileHeader = (
  file: PreparedZipFile,
  dosTimestamp: ReturnType<typeof getDosTimestamp>,
) => {
  const header = new Uint8Array(30 + file.nameBytes.length);
  const view = new DataView(header.buffer);

  writeUint32(view, 0, 0x04034b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 0);
  writeUint16(view, 8, 0);
  writeUint16(view, 10, dosTimestamp.time);
  writeUint16(view, 12, dosTimestamp.date);
  writeUint32(view, 14, file.crc);
  writeUint32(view, 18, file.data.length);
  writeUint32(view, 22, file.data.length);
  writeUint16(view, 26, file.nameBytes.length);
  writeUint16(view, 28, 0);
  header.set(file.nameBytes, 30);

  return header;
};

const createCentralDirectoryHeader = (
  file: PreparedZipFile,
  dosTimestamp: ReturnType<typeof getDosTimestamp>,
) => {
  const header = new Uint8Array(46 + file.nameBytes.length);
  const view = new DataView(header.buffer);

  writeUint32(view, 0, 0x02014b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 20);
  writeUint16(view, 8, 0);
  writeUint16(view, 10, 0);
  writeUint16(view, 12, dosTimestamp.time);
  writeUint16(view, 14, dosTimestamp.date);
  writeUint32(view, 16, file.crc);
  writeUint32(view, 20, file.data.length);
  writeUint32(view, 24, file.data.length);
  writeUint16(view, 28, file.nameBytes.length);
  writeUint16(view, 30, 0);
  writeUint16(view, 32, 0);
  writeUint16(view, 34, 0);
  writeUint16(view, 36, 0);
  writeUint32(view, 38, 0);
  writeUint32(view, 42, file.offset);
  header.set(file.nameBytes, 46);

  return header;
};

const createEndOfCentralDirectory = (
  fileCount: number,
  centralDirectorySize: number,
  centralDirectoryOffset: number,
) => {
  const header = new Uint8Array(22);
  const view = new DataView(header.buffer);

  writeUint32(view, 0, 0x06054b50);
  writeUint16(view, 4, 0);
  writeUint16(view, 6, 0);
  writeUint16(view, 8, fileCount);
  writeUint16(view, 10, fileCount);
  writeUint32(view, 12, centralDirectorySize);
  writeUint32(view, 16, centralDirectoryOffset);
  writeUint16(view, 20, 0);

  return header;
};

const createZipBlob = (files: ZipSourceFile[]) => {
  const dosTimestamp = getDosTimestamp();
  let offset = 0;
  const preparedFiles = files.map((file): PreparedZipFile => {
    const data = encodeUtf8(file.content);
    const preparedFile = {
      nameBytes: encodeUtf8(file.name),
      data,
      crc: calculateCrc32(data),
      offset,
    };

    offset += 30 + preparedFile.nameBytes.length + data.length;
    return preparedFile;
  });

  const localParts = preparedFiles.flatMap((file) => [
    createLocalFileHeader(file, dosTimestamp),
    file.data,
  ]);
  const centralDirectoryOffset = offset;
  const centralDirectoryParts = preparedFiles.map((file) =>
    createCentralDirectoryHeader(file, dosTimestamp),
  );
  const centralDirectorySize = centralDirectoryParts.reduce(
    (sum, part) => sum + part.length,
    0,
  );

  return new Blob(
    [
      concatUint8Arrays([
        ...localParts,
        ...centralDirectoryParts,
        createEndOfCentralDirectory(
          preparedFiles.length,
          centralDirectorySize,
          centralDirectoryOffset,
        ),
      ]),
    ],
    { type: XLSX_MIME_TYPE },
  );
};

const escapeXml = (value: string) =>
  value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f<>&"']/g, (character) => {
    switch (character) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return "";
    }
  });

const getColumnName = (index: number) => {
  let column = "";
  let value = index + 1;

  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }

  return column;
};

const buildCell = (value: string | number | null | undefined, row: number, column: number, bold = false) => {
  const normalizedValue = value === null || value === undefined ? "" : String(value);
  const reference = `${getColumnName(column)}${row}`;
  const style = bold ? ' s="1"' : "";

  if (typeof value === "number") return `<c r="${reference}"${style}><v>${value}</v></c>`;
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(normalizedValue)}</t></is></c>`;
};

const dateFormat = new Intl.DateTimeFormat("pl-PL", {
  timeZone: "Europe/Warsaw", day: "numeric", month: "long", year: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("pl-PL", {
  timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

const readDate = (value?: string | null) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
};

const formatMoment = (date: Date) => `${dateFormat.format(date)} · ${timeFormat.format(date)}`;
const formatTerm = (startValue?: string, endValue?: string) => {
  const start = readDate(startValue);
  const end = readDate(endValue);
  if (!start) return "—";
  if (!end) return formatMoment(start);
  return dateFormat.format(start) === dateFormat.format(end)
    ? `${formatMoment(start)}–${timeFormat.format(end)}`
    : `${formatMoment(start)} – ${formatMoment(end)}`;
};

const getMetadata = (draft: AttendanceDraft): [string, string | number][] => {
  const opened = readDate(draft.openedAt);
  const closed = readDate(draft.closedAt);
  const lifetime = [
    opened && `Otwarto ${formatMoment(opened)}`,
    closed && `Zamknięto ${formatMoment(closed)}`,
  ].filter(Boolean).join(" / ");

  const metadata: [string, string | number][] = [
    ["Przedmiot", draft.title || "—"],
    ["Prowadzący", draft.lecturerDisplayName || draft.lecturerUsername || "—"],
    ["Termin zajęć", formatTerm(draft.lessonStart, draft.lessonEnd)],
    ["Sala", draft.room || "—"],
    ["Grupa", draft.group || "—"],
    ["Stan", draft.simulated ? `${attendanceStatusLabel[draft.status]} · Symulacja Kantecha` : attendanceStatusLabel[draft.status]],
    ["Liczba wpisów", draft.rows.length],
    ["Wygenerowano", formatMoment(new Date())],
  ];
  if (lifetime) metadata.push(["Przebieg listy", lifetime]);
  return metadata;
};

const attendanceColumns = ["Lp.", "Imię", "Nazwisko", "Numer albumu", "Godzina odbicia"];
const worksheetRow = (row: number, cells: string) => `<row r="${row}">${cells}</row>`;

const buildWorksheetXml = (draft: AttendanceDraft) => {
  const metadata = getMetadata(draft);
  const headerRow = metadata.length + 3;
  const firstEntryRow = headerRow + 1;
  const lastRow = headerRow + draft.rows.length;
  const sheetRows = [worksheetRow(1, buildCell("PlanQR · Lista obecności", 1, 0, true))];

  metadata.forEach(([label, value], index) => {
    const row = index + 2;
    sheetRows.push(worksheetRow(row, buildCell(label, row, 0) + buildCell(value, row, 1)));
  });
  sheetRows.push(worksheetRow(headerRow, attendanceColumns
    .map((value, column) => buildCell(value, headerRow, column, true)).join("")));
  draft.rows.forEach((entry, index) => {
    const row = firstEntryRow + index;
    const values = [index + 1, entry.givenName, entry.surname, entry.albumNumber, entry.enteredAt];
    sheetRows.push(worksheetRow(row, values
      .map((value, column) => buildCell(value, row, column)).join("")));
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:E${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0" showGridLines="1"><pane ySplit="${headerRow}" topLeftCell="A${firstEntryRow}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>
    <col min="1" max="1" width="17" customWidth="1"/>
    <col min="2" max="3" width="26" customWidth="1"/>
    <col min="4" max="4" width="19" customWidth="1"/>
    <col min="5" max="5" width="23" customWidth="1"/>
  </cols>
  <sheetData>${sheetRows.join("")}</sheetData>
  <autoFilter ref="A${headerRow}:E${lastRow}"/>
</worksheet>`;
};

const buildXlsxFiles = (worksheetXml: string): ZipSourceFile[] => [
  {
    name: "[Content_Types].xml",
    content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
  },
  {
    name: "_rels/.rels",
    content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  },
  {
    name: "docProps/core.xml",
    content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Lista obecności</dc:title>
  <dc:creator>PlanQR</dc:creator>
  <cp:lastModifiedBy>PlanQR</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`,
  },
  {
    name: "docProps/app.xml",
    content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>PlanQR</Application>
</Properties>`,
  },
  {
    name: "xl/workbook.xml",
    content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Obecności" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`,
  },
  {
    name: "xl/_rels/workbook.xml.rels",
    content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  },
  {
    name: "xl/styles.xml",
    content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
  },
  {
    name: "xl/worksheets/sheet1.xml",
    content: worksheetXml,
  },
];

const sanitizeFileSegment = (value: string) =>
  value
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 48);

const buildAttendanceFileName = (
  draft: AttendanceDraft,
  lessonId?: string | number | null,
) => {
  const dateSegment = new Date().toISOString().slice(0, 10);
  const idSegment = sanitizeFileSegment(String(lessonId ?? draft.lessonId ?? draft.sessionId ?? ""));
  const prefix = draft.simulated ? "obecnosci-symulacja" : "obecnosci";

  return `${prefix}${idSegment ? `-${idSegment}` : ""}-${dateSegment}.xlsx`;
};

export const downloadAttendanceXlsx = (
  draft: AttendanceDraft,
  lessonId?: string | number | null,
) => {
  const worksheetXml = buildWorksheetXml(draft);
  const blob = createZipBlob(buildXlsxFiles(worksheetXml));
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = buildAttendanceFileName(draft, lessonId);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};
