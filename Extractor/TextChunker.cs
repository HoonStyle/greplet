namespace Extractor;

/// <summary>
/// C#/PDF 외 텍스트 파일(.xaml .csproj .sln .proto .config .settings .manifest .md .txt) 청킹(§4.5).
/// 3000자/오버랩 300자 줄 윈도우, symbol L{start}-{end}, kind text, 헤더 1줄.
/// </summary>
public static class TextChunker
{
    private const int TargetSize = 3000;
    private const int OverlapSize = 300;

    public static List<RawChunk> Chunk(string relFile, string text)
    {
        var lines = text.Replace("\r\n", "\n").Replace("\r", "\n").Split('\n');
        var windows = Windowing.Split(lines, TargetSize, OverlapSize);
        var chunks = new List<RawChunk>();
        string header = $"// {relFile}\n";
        foreach (var w in windows)
        {
            int startLine = w.StartLineIndex + 1;
            int endLine = w.EndLineIndex + 1;
            chunks.Add(new RawChunk($"L{startLine}-{endLine}", "text", startLine, endLine, header + w.Text));
        }
        return chunks;
    }
}
