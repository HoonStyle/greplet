/*
  tokens.ts — 검색 응답의 근사 토큰 수 추정(§활동 이벤트). 정확한 토크나이저가 아니다.
*/

/** 근사 토큰 수. ASCII 는 4자당 1토큰, 그 외(한글·CJK 등)는 1자당 1토큰으로 센다. 정확한 토크나이저가 아니다. */
export function approxTokens(text: string): number {
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) asciiCount++;
    else nonAsciiCount++;
  }
  return Math.ceil(asciiCount / 4) + nonAsciiCount;
}

/** hits 를 클라이언트가 출력하는 형태로 근사: 각 hit 의 text 를 공백 정규화 후 snippetChars 로 자르고(undefined=전문), hit 당 헤더(파일:라인 등) 약 12토큰을 더한다. */
export function approxResponseTokens(hits: { text: string }[], snippetChars: number | undefined): number {
  const HEADER_TOKENS_PER_HIT = 12;
  let total = 0;
  for (const hit of hits) {
    const normalized = hit.text.replace(/\s+/g, " ").trim();
    const sliced = typeof snippetChars === "number" ? normalized.slice(0, snippetChars) : normalized;
    total += approxTokens(sliced) + HEADER_TOKENS_PER_HIT;
  }
  return total;
}
