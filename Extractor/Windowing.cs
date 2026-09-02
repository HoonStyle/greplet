namespace Extractor;

/// <summary>
/// 줄 경계를 지키는 문자수 윈도우 분할(§4.4-5, §4.5, §4.6). 여러 청커가 공유한다.
/// </summary>
public static class Windowing
{
    public sealed record Window(string Text, int StartLineIndex, int EndLineIndex);

    /// <summary>
    /// lines(0-based) 를 targetSize 문자 내외로 묶고, 다음 윈도우는 overlapSize 문자만큼 겹치게 시작한다.
    /// 줄 중간을 자르지 않는다.
    /// </summary>
    public static List<Window> Split(IReadOnlyList<string> lines, int targetSize, int overlapSize)
    {
        var result = new List<Window>();
        if (lines.Count == 0) return result;

        int i = 0;
        while (i < lines.Count)
        {
            var sb = new System.Text.StringBuilder();
            int start = i;
            int j = i;
            while (j < lines.Count && (sb.Length < targetSize || j == start))
            {
                sb.Append(lines[j]);
                sb.Append('\n');
                j++;
            }
            int end = j - 1;
            result.Add(new Window(sb.ToString(), start, end));

            if (j >= lines.Count) break;

            // 다음 시작 위치: 끝에서부터 overlapSize 문자만큼 뒤로 물러난 줄
            int backChars = 0;
            int k = end;
            while (k > start && backChars < overlapSize)
            {
                backChars += lines[k].Length + 1;
                k--;
            }
            int next = k + 1;
            i = next > start ? next : start + 1; // 항상 앞으로 진행 보장
        }
        return result;
    }
}
