// evidence-pdf.mjs — 의존성 없이 최소 유효 PDF 를 만드는 헬퍼. PdfPig 이 파싱할 수 있는 최소 구조만 채운다.
// evidence.mjs 의 PDF 페이지/분할 청크 조회 시나리오 전용 fixture 생성기.

function escapePdfText(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * pages: string[] — 페이지별 본문. 각 문자열은 줄바꿈으로 나뉘어 개별 Tj 로 배치된다.
 * 반환값은 PDF 바이트(Buffer)다. 페이지 밖으로 y 좌표가 나가도 PdfPig 텍스트 추출에는 영향 없다.
 */
export function buildTestPdf(pages) {
  const objects = []; // index i -> object id i+1
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  const contentIds = [];
  const pageIds = [];
  let nextId = 4;
  for (let i = 0; i < pages.length; i++) {
    contentIds.push(nextId++);
    pageIds.push(nextId++);
  }

  const lineHeight = 14;
  function contentStreamFor(text) {
    const lines = text.split("\n");
    let body = "BT\n/F1 11 Tf\n50 780 Td\n";
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) body += `0 -${lineHeight} Td\n`;
      body += `(${escapePdfText(lines[i])}) Tj\n`;
    }
    body += "ET\n";
    return body;
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[fontId - 1] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  for (let i = 0; i < pages.length; i++) {
    const stream = contentStreamFor(pages[i]);
    const bytesLen = Buffer.byteLength(stream, "latin1");
    objects[contentIds[i] - 1] = `<< /Length ${bytesLen} >>\nstream\n${stream}endstream`;
    objects[pageIds[i] - 1] =
      `<< /Type /Page /Parent ${pagesId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> ` +
      `/MediaBox [0 0 612 792] /Contents ${contentIds[i]} 0 R >>`;
  }

  const total = objects.length;
  let out = "%PDF-1.4\n";
  const offsets = new Array(total + 1).fill(0);
  for (let id = 1; id <= total; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objects[id - 1]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= total; id++) {
    out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${total + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(out, "latin1");
}
