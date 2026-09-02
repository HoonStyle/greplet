using System.Text.RegularExpressions;
using UglyToad.PdfPig;
using UglyToad.PdfPig.DocumentLayoutAnalysis.TextExtractor;

namespace Extractor;

/// <summary>
/// PDF 페이지 단위 청킹(§4.6). PdfPig 로 페이지별 텍스트를 뽑고, 페이지 = 청크 1개(3000자 넘으면 분할).
/// </summary>
public static class PdfChunker
{
    private const int TargetSize = 3000;
    private const int OverlapSize = 300;
    private const int MinPageChars = 30;

    private static readonly Regex WhitespaceRun = new(@"[ \t]+", RegexOptions.Compiled);
    private static readonly Regex BlankLineRun = new(@"(\n\s*){3,}", RegexOptions.Compiled);

    public sealed record Result(List<RawChunk> Chunks, int SkippedPages, string? Error);

    public static Result Chunk(string relFile, string absPath, IReadOnlyList<string>? passwords)
    {
        var pwList = (passwords is { Count: > 0 } ? passwords : new List<string> { "" }).ToList();
        if (!pwList.Contains("")) pwList.Insert(0, "");

        try
        {
            using var document = PdfDocument.Open(absPath, new ParsingOptions { Passwords = pwList });
            var chunks = new List<RawChunk>();
            int total = document.NumberOfPages;
            int skipped = 0;

            foreach (var page in document.GetPages())
            {
                string raw;
                try
                {
                    raw = ContentOrderTextExtractor.GetText(page);
                }
                catch
                {
                    skipped++;
                    continue;
                }
                string normalized = Normalize(raw);
                if (normalized.Length < MinPageChars)
                {
                    skipped++;
                    continue;
                }

                string header = $"// {relFile}\n// page {page.Number}/{total}\n";
                if (normalized.Length <= TargetSize)
                {
                    chunks.Add(new RawChunk($"p.{page.Number}", "page", page.Number, page.Number, header + normalized));
                }
                else
                {
                    var lines = normalized.Split('\n');
                    var windows = Windowing.Split(lines, TargetSize, OverlapSize);
                    int k = 1;
                    foreach (var w in windows)
                    {
                        chunks.Add(new RawChunk($"p.{page.Number}#{k}", "page", page.Number, page.Number, header + w.Text));
                        k++;
                    }
                }
            }
            return new Result(chunks, skipped, null);
        }
        catch (Exception ex)
        {
            return new Result(new List<RawChunk>(), 0, ex.Message);
        }
    }

    /// <summary>공백 정규화: 연속 공백/탭 압축, 빈 줄 3줄 이상 압축.</summary>
    private static string Normalize(string text)
    {
        var t = text.Replace("\r\n", "\n").Replace("\r", "\n");
        t = WhitespaceRun.Replace(t, " ");
        t = BlankLineRun.Replace(t, "\n\n");
        return t.Trim();
    }
}
