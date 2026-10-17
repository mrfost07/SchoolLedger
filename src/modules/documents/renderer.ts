import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import type { DocumentSnapshot } from './payload';

const INSTITUTION_NAME = 'StudentsPortal University';
const OFFICE_LINE = 'Office of the University Registrar';

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 50;
const LINE = 14;

const INK = rgb(0.13, 0.13, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const ACCENT = rgb(0.06, 0.32, 0.5);

const TITLES: Record<DocumentSnapshot['documentType'], string> = {
  COR: 'CERTIFICATE OF REGISTRATION',
  GRADE_SLIP: 'GRADE SLIP',
  TOR_UNOFFICIAL: 'UNOFFICIAL TRANSCRIPT OF RECORDS',
  TOR_OFFICIAL: 'OFFICIAL TRANSCRIPT OF RECORDS',
  CERT_GRADES: 'CERTIFICATE OF GRADES',
  CERT_GOOD_MORAL: 'CERTIFICATE OF GOOD MORAL CHARACTER',
  CERT_ENROLLMENT: 'CERTIFICATE OF ENROLLMENT',
};

interface Cursor {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
}

function newPage(cursor: Cursor): void {
  cursor.page = cursor.doc.addPage([A4.width, A4.height]);
  cursor.y = A4.height - MARGIN;
}

function ensureSpace(cursor: Cursor, needed: number): void {
  if (cursor.y - needed < MARGIN + 40) newPage(cursor);
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawText(
  cursor: Cursor,
  text: string,
  options: { size?: number; bold?: boolean; x?: number; color?: ReturnType<typeof rgb>; maxWidth?: number; alignRight?: boolean } = {},
): void {
  const size = options.size ?? 10;
  const font = options.bold ? cursor.bold : cursor.regular;
  const color = options.color ?? INK;
  const maxWidth = options.maxWidth ?? A4.width - MARGIN * 2;
  for (const line of wrap(font, text, size, maxWidth)) {
    ensureSpace(cursor, LINE);
    if (options.alignRight) {
      const width = font.widthOfTextAtSize(line, size);
      cursor.page.drawText(line, { x: A4.width - MARGIN - width, y: cursor.y, size, font, color });
    } else {
      cursor.page.drawText(line, { x: options.x ?? MARGIN, y: cursor.y, size, font, color });
    }
    cursor.y -= LINE;
  }
}

function rule(cursor: Cursor, color = MUTED): void {
  ensureSpace(cursor, LINE);
  cursor.page.drawLine({
    start: { x: MARGIN, y: cursor.y + 6 },
    end: { x: A4.width - MARGIN, y: cursor.y + 6 },
    thickness: 0.75,
    color,
  });
  cursor.y -= 8;
}

function drawStudentBlock(cursor: Cursor, snapshot: DocumentSnapshot): void {
  const { student } = snapshot;
  drawText(cursor, `Student: ${student.lastName.toUpperCase()}, ${student.firstName}`, { size: 11, bold: true });
  drawText(cursor, `Student No: ${student.studentNo}    Year Level: ${student.yearLevel}`, { size: 9.5, color: MUTED });
  drawText(cursor, `Program: ${student.program.degreeTitle} (${student.program.code}) — Curriculum ${student.curriculumVersion}`, {
    size: 9.5,
    color: MUTED,
  });
  if (snapshot.term) {
    drawText(cursor, `Term: ${snapshot.term.code}  (SY ${snapshot.term.schoolYear}, Term ${snapshot.term.termNo})`, {
      size: 9.5,
      color: MUTED,
    });
  }
}

function drawGradesTable(cursor: Cursor, snapshot: DocumentSnapshot): void {
  const grades = snapshot.grades;
  if (!grades) return;

  drawText(cursor, 'Grades', { size: 11, bold: true });
  cursor.y -= 2;

  const columns = [
    { key: 'termCode', label: 'Term', x: MARGIN, width: 62 },
    { key: 'courseCode', label: 'Course', x: MARGIN + 62, width: 76 },
    { key: 'courseTitle', label: 'Title', x: MARGIN + 138, width: 210 },
    { key: 'units', label: 'Units', x: MARGIN + 348, width: 44 },
    { key: 'mark', label: 'Mark', x: A4.width - MARGIN - 56, width: 56 },
  ] as const;

  const header = (): void => {
    ensureSpace(cursor, LINE * 2);
    for (const col of columns) {
      cursor.page.drawText(col.label, {
        x: col.x,
        y: cursor.y,
        size: 9,
        font: cursor.bold,
        color: ACCENT,
      });
    }
    cursor.y -= 4;
    rule(cursor);
    cursor.y += 2;
  };

  header();
  for (const entry of grades.entries) {
    if (cursor.y - LINE < MARGIN + 40) {
      newPage(cursor);
      drawText(cursor, `${TITLES[snapshot.documentType]} (continued)`, { size: 10, bold: true, color: MUTED });
      header();
    }
    cursor.page.drawText(entry.termCode, { x: columns[0].x, y: cursor.y, size: 9, font: cursor.regular, color: INK });
    cursor.page.drawText(entry.courseCode, { x: columns[1].x, y: cursor.y, size: 9, font: cursor.bold, color: INK });
    cursor.page.drawText(entry.courseTitle.slice(0, 46), { x: columns[2].x, y: cursor.y, size: 9, font: cursor.regular, color: INK });
    cursor.page.drawText(String(entry.units), { x: columns[3].x, y: cursor.y, size: 9, font: cursor.regular, color: INK });
    cursor.page.drawText(entry.mark, { x: columns[4].x, y: cursor.y, size: 9, font: cursor.bold, color: INK });
    cursor.y -= LINE;
  }
  rule(cursor);

  drawText(cursor, `Cumulative GWA: ${grades.cumulativeGwa ?? '—'}    Total Units: ${grades.totalUnits}`, { size: 10, bold: true });
  drawText(cursor, `Academic Standing: ${grades.standing.replaceAll('_', ' ')}${grades.latinHonors ? `    Honors: ${grades.latinHonors.replaceAll('_', ' ')}` : ''}`, {
    size: 9.5,
    color: MUTED,
  });
}

function drawEnrollmentBlock(cursor: Cursor, snapshot: DocumentSnapshot): void {
  const enrollment = snapshot.enrollment;
  if (!enrollment) return;

  drawText(cursor, 'Enrolled Subjects', { size: 11, bold: true });
  cursor.y -= 2;
  for (const item of enrollment.items) {
    drawText(cursor, `${item.sectionCode}  ${item.courseCode}  ${item.courseTitle}  (${item.units} units, ${item.status})`, {
      size: 9.5,
      color: INK,
    });
  }
  if (enrollment.assessment) {
    drawText(
      cursor,
      `Assessment: ${enrollment.assessment.currency} ${enrollment.assessment.totalAmount} (${enrollment.assessment.status})`,
      { size: 9.5, bold: true },
    );
  }
}

/**
 * Deterministic A4 renderer: institution header, QR verification block,
 * document body and a signed footer on every page.
 */
export async function renderDocumentPdf(
  snapshot: DocumentSnapshot,
  meta: { snapshotHash: string; signature: string },
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const qrPng = await QRCode.toBuffer(snapshot.verification.verifyUrl, { type: 'png', width: 256, margin: 1 });
  const qrImage = await doc.embedPng(qrPng);

  doc.setTitle(`${TITLES[snapshot.documentType]} — ${snapshot.student.studentNo}`);
  doc.setAuthor(INSTITUTION_NAME);
  doc.setSubject(`Serial ${snapshot.serialNo}`);
  doc.setProducer('StudentsPortal Document Service');
  const issuedAt = new Date(snapshot.issuedAt);
  doc.setCreationDate(issuedAt);
  doc.setModificationDate(issuedAt);

  const cursor: Cursor = { doc, page: doc.addPage([A4.width, A4.height]), y: A4.height - MARGIN, regular, bold };

  drawText(cursor, INSTITUTION_NAME, { size: 16, bold: true, color: ACCENT });
  drawText(cursor, OFFICE_LINE, { size: 10, color: MUTED });
  rule(cursor);

  const qrSize = 84;
  const qrX = A4.width - MARGIN - qrSize;
  const qrY = cursor.y - qrSize + 6;
  cursor.page.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize });
  cursor.page.drawText('Scan to verify', {
    x: qrX + 10,
    y: qrY - 10,
    size: 7.5,
    font: regular,
    color: MUTED,
  });

  drawText(cursor, TITLES[snapshot.documentType], { size: 14, bold: true, maxWidth: A4.width - MARGIN * 2 - qrSize - 12 });
  drawText(cursor, `Serial No: ${snapshot.serialNo}`, { size: 9, color: MUTED });
  drawText(cursor, `Issued: ${issuedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`, { size: 9, color: MUTED });
  cursor.y -= 6;

  drawStudentBlock(cursor, snapshot);
  cursor.y -= 4;

  if (snapshot.documentType === 'COR' || snapshot.documentType === 'CERT_ENROLLMENT' || snapshot.documentType === 'GRADE_SLIP') {
    drawEnrollmentBlock(cursor, snapshot);
    cursor.y -= 4;
  }
  if (snapshot.grades) {
    drawGradesTable(cursor, snapshot);
    cursor.y -= 4;
  }
  if (snapshot.remarks?.length) {
    for (const remark of snapshot.remarks) drawText(cursor, remark, { size: 9.5, color: MUTED });
    cursor.y -= 4;
  }

  cursor.y = Math.max(cursor.y, MARGIN + 90);
  cursor.y -= 20;
  drawText(cursor, 'Electronically issued. The QR code resolves to the official verification endpoint.', { size: 8.5, color: MUTED });
  drawText(cursor, `Snapshot SHA-256: ${meta.snapshotHash}`, { size: 7.5, color: MUTED });
  drawText(cursor, `HMAC: ${meta.signature.slice(0, 32)}…`, { size: 7.5, color: MUTED });

  const pages = doc.getPages();
  const footer = `Serial ${snapshot.serialNo} · Page {PAGE}/${pages.length} · ${snapshot.verification.verifyUrl}`;
  pages.forEach((page, index) => {
    const text = footer.replace('{PAGE}', String(index + 1));
    const size = 7.5;
    const width = regular.widthOfTextAtSize(text, size);
    page.drawLine({
      start: { x: MARGIN, y: MARGIN + 8 },
      end: { x: A4.width - MARGIN, y: MARGIN + 8 },
      thickness: 0.5,
      color: MUTED,
    });
    page.drawText(text, { x: A4.width - MARGIN - width, y: MARGIN, size, font: regular, color: MUTED });
  });

  return Buffer.from(await doc.save());
}
