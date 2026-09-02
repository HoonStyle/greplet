using System.Text.Json.Serialization;

namespace Extractor;

/// <summary>
/// 청킹 단계에서 만들어지는 청크 하나. Text 에는 이미 컨텍스트 헤더(§4.4-4)가 포함돼 있다.
/// </summary>
public sealed record RawChunk(string Symbol, string Kind, int StartLine, int EndLine, string Text);

/// <summary>
/// JSONL 한 줄로 직렬화되는 최종 레코드 (§4.2). 필드명은 docs/design.md §4.2 그대로.
/// </summary>
public sealed class ChunkRecord
{
    [JsonPropertyName("file")] public string File { get; set; } = "";
    [JsonPropertyName("abs")] public string Abs { get; set; } = "";
    [JsonPropertyName("root")] public string Root { get; set; } = "";
    [JsonPropertyName("hash")] public string Hash { get; set; } = "";
    [JsonPropertyName("symbol")] public string Symbol { get; set; } = "";
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("startLine")] public int StartLine { get; set; }
    [JsonPropertyName("endLine")] public int EndLine { get; set; }
    [JsonPropertyName("text")] public string Text { get; set; } = "";
}
