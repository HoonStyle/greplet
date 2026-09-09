using System.Text.Json;
using Extractor;

// Extractor — Roslyn 멤버 단위·PdfPig 페이지 단위 청크 추출기 (§4.1)
//
// 사용법:
//   Extractor --root <dir> [--root <dir2> ...]
//             --ext .cs,.xaml --exclude-dir bin,obj --exclude-file "*.Designer.cs,AssemblyInfo.cs"
//             [--files <list.txt>] [--pdf-password-file <path>]
//             --out <chunks.jsonl>
//
// 종료 코드: 0 = 전체 성공, 2 = 일부 파일 실패(계속 진행, 실패 목록은 stderr).

var opts = CliOptions.Parse(args);
if (opts == null)
{
    Console.Error.WriteLine("사용법: Extractor --root <dir> [--root <dir2> ...] --ext .cs,.xaml [--exclude-dir bin,obj] [--exclude-file glob1,glob2] [--files list.txt] [--pdf-password-file pw.txt] --out chunks.jsonl");
    return 1;
}

List<string> passwords = new();
if (opts.PdfPasswordFile != null && File.Exists(opts.PdfPasswordFile))
{
    passwords = File.ReadAllLines(opts.PdfPasswordFile).Where(l => l.Length > 0 || true).ToList();
    // 빈 비밀번호를 먼저 시도(§4.6) — PdfChunker 가 "" 를 항상 맨 앞에 넣어주므로 여기서는 파일 내용 그대로 전달.
}

List<string> targetFiles;
if (opts.FilesListPath != null)
{
    targetFiles = File.ReadAllLines(opts.FilesListPath)
        .Select(l => l.Trim())
        .Where(l => l.Length > 0)
        .ToList();
}
else
{
    targetFiles = FileScanner.Enumerate(opts.Roots, opts.Extensions, opts.ExcludeDirs, opts.ExcludeFiles);
}

Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(opts.Out))!);
using var outStream = new StreamWriter(opts.Out, append: false, new System.Text.UTF8Encoding(false));

int total = targetFiles.Count;
int n = 0;
int failCount = 0;
int pdfSkippedTotal = 0;
var failedFiles = new List<string>();

foreach (var absPath in targetFiles)
{
    n++;
    try
    {
        string root = FindContainingRoot(absPath, opts.Roots) ?? Path.GetDirectoryName(absPath) ?? absPath;
        string relFile = Path.GetRelativePath(root, absPath).Replace('\\', '/');
        string ext = Path.GetExtension(absPath).ToLowerInvariant();

        List<RawChunk> rawChunks;
        byte[] originalBytes;

        if (ext == ".pdf")
        {
            originalBytes = File.ReadAllBytes(absPath);
            var result = PdfChunker.Chunk(relFile, absPath, passwords);
            if (result.Error != null)
            {
                throw new InvalidOperationException($"PDF 열기 실패: {result.Error}");
            }
            rawChunks = result.Chunks;
            pdfSkippedTotal += result.SkippedPages;
        }
        else
        {
            var (bytes, text) = TextEncodingHelper.ReadFile(absPath);
            originalBytes = bytes;
            if (ext == ".cs")
            {
                rawChunks = CSharpChunker.Chunk(relFile, text) ?? TextChunker.Chunk(relFile, text);
            }
            else if (ext == ".html" || ext == ".htm")
            {
                // 설계 문서 HTML: 태그·스크립트·스타일을 걷어낸 평문을 텍스트 규칙(§4.5)으로 청킹
                rawChunks = TextChunker.Chunk(relFile, HtmlText.ToPlainText(text));
            }
            else
            {
                rawChunks = TextChunker.Chunk(relFile, text);
            }
        }

        string hash = TextEncodingHelper.Sha256Hex(originalBytes);
        foreach (var c in rawChunks)
        {
            var record = new ChunkRecord
            {
                File = relFile,
                Abs = absPath,
                Root = root,
                Hash = hash,
                Symbol = c.Symbol,
                Kind = c.Kind,
                StartLine = c.StartLine,
                EndLine = c.EndLine,
                Text = c.Text,
            };
            outStream.WriteLine(JsonSerializer.Serialize(record));
        }

        Console.WriteLine($"[{n}/{total}] {relFile} → {rawChunks.Count} chunks");
    }
    catch (Exception ex)
    {
        failCount++;
        failedFiles.Add(absPath);
        Console.Error.WriteLine($"[실패] {absPath}: {ex.Message}");
    }
}

outStream.Flush();

if (pdfSkippedTotal > 0)
{
    Console.Error.WriteLine($"[요약] PDF 스캔 이미지 등으로 스킵한 페이지 총 {pdfSkippedTotal}건");
}

if (failCount > 0)
{
    Console.Error.WriteLine($"[요약] 실패 {failCount}/{total}건:");
    foreach (var f in failedFiles) Console.Error.WriteLine($"  - {f}");
    return 2;
}

return 0;

static string? FindContainingRoot(string absPath, IReadOnlyList<string> roots)
{
    string? best = null;
    foreach (var r in roots)
    {
        // Path.GetFullPath expands Windows 8.3 short names (e.g. RUNNER~1) but the target
        // paths from the indexer do not, so also try the root exactly as the indexer passed it.
        foreach (var candidate in new[] { Path.GetFullPath(r), r.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) })
        {
            if (absPath.StartsWith(candidate, StringComparison.OrdinalIgnoreCase))
            {
                if (best == null || candidate.Length > best.Length) best = candidate;
            }
        }
    }
    return best;
}

/// <summary>CLI 인자 파싱.</summary>
internal sealed class CliOptions
{
    public List<string> Roots { get; } = new();
    public List<string> Extensions { get; } = new();
    public List<string> ExcludeDirs { get; } = new();
    public List<string> ExcludeFiles { get; } = new();
    public string? FilesListPath { get; set; }
    public string? PdfPasswordFile { get; set; }
    public string Out { get; set; } = "";

    public static CliOptions? Parse(string[] args)
    {
        var opts = new CliOptions();
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            string Next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"{a} 뒤에 값이 필요합니다");
            switch (a)
            {
                case "--root": opts.Roots.Add(Next()); break;
                case "--ext": opts.Extensions.AddRange(SplitCsv(Next())); break;
                case "--exclude-dir": opts.ExcludeDirs.AddRange(SplitCsv(Next())); break;
                case "--exclude-file": opts.ExcludeFiles.AddRange(SplitCsv(Next())); break;
                case "--files": opts.FilesListPath = Next(); break;
                case "--pdf-password-file": opts.PdfPasswordFile = Next(); break;
                case "--out": opts.Out = Next(); break;
                default:
                    Console.Error.WriteLine($"알 수 없는 인자: {a}");
                    return null;
            }
        }
        if (opts.Out.Length == 0) return null;
        if (opts.Roots.Count == 0 && opts.FilesListPath == null) return null;
        return opts;
    }

    private static IEnumerable<string> SplitCsv(string s) => s.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}
