using System.Net;
using System.Text.RegularExpressions;

namespace Extractor;

/// <summary>
/// HTML 문서(.html .htm)를 검색용 평문으로 바꾼다.
/// script/style/head 블록 제거 → 블록 요소 경계를 줄바꿈으로 → 나머지 태그 제거 → 엔티티 디코드 → 공백 정리.
/// 결과는 TextChunker 로 넘기며, 이때 청크의 줄번호는 원본 HTML 이 아니라 변환된 평문 기준이다.
/// </summary>
public static partial class HtmlText
{
    [GeneratedRegex(@"<(script|style|head|svg|noscript)\b[^>]*>.*?</\1\s*>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex DropBlocks();

    [GeneratedRegex(@"<!--.*?-->", RegexOptions.Singleline)]
    private static partial Regex Comments();

    [GeneratedRegex(@"<\s*(/?)\s*(p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|pre|blockquote|dt|dd|hr|caption|figcaption)\b[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex BlockTags();

    [GeneratedRegex(@"<[^>]+>")]
    private static partial Regex AnyTag();

    [GeneratedRegex(@"[ \t ]+")]
    private static partial Regex HorizontalSpace();

    [GeneratedRegex(@"\n{3,}")]
    private static partial Regex ManyNewlines();

    public static string ToPlainText(string html)
    {
        string s = html.Replace("\r\n", "\n").Replace('\r', '\n');
        s = DropBlocks().Replace(s, "\n");
        s = Comments().Replace(s, string.Empty);
        // 블록 요소 경계는 줄바꿈으로 남겨 문단·표 셀이 한 줄로 붙지 않게 한다(표 셀은 탭으로 구분).
        s = BlockTags().Replace(s, m => m.Groups[2].Value.ToLowerInvariant() is "td" or "th" ? "\t" : "\n");
        s = AnyTag().Replace(s, string.Empty);
        s = WebUtility.HtmlDecode(s);
        s = HorizontalSpace().Replace(s, " ");
        // 줄 앞뒤 공백 제거 후 빈 줄은 최대 2개까지만
        var lines = s.Split('\n').Select(l => l.Trim());
        s = string.Join("\n", lines);
        s = ManyNewlines().Replace(s, "\n\n");
        return s.Trim();
    }
}
