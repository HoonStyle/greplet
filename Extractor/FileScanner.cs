namespace Extractor;

/// <summary>
/// 루트 디렉터리 열거 규칙. Node indexer/src/scan.ts 와 동일해야 한다(§4.1):
/// ext 소문자 비교, 경로 세그먼트 중 하나라도 exclude-dir 이면 제외, 파일명 글롭 매칭.
/// </summary>
public static class FileScanner
{
    public static List<string> Enumerate(IReadOnlyList<string> roots, IReadOnlyList<string> extensions,
        IReadOnlyList<string> excludeDirs, IReadOnlyList<string> excludeFileGlobs)
    {
        var extSet = extensions.Select(e => e.ToLowerInvariant()).ToHashSet();
        var excludeDirSet = excludeDirs.Select(d => d.ToLowerInvariant()).ToHashSet();
        var results = new List<string>();

        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;
            foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
            {
                string ext = Path.GetExtension(file).ToLowerInvariant();
                if (!extSet.Contains(ext)) continue;

                string rel = Path.GetRelativePath(root, file);
                var segments = rel.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                bool excluded = false;
                foreach (var seg in segments)
                {
                    if (excludeDirSet.Contains(seg.ToLowerInvariant())) { excluded = true; break; }
                }
                if (excluded) continue;

                string fileName = Path.GetFileName(file);
                if (excludeFileGlobs.Any(g => MatchesGlob(fileName, g))) continue;

                results.Add(file);
            }
        }
        return results;
    }

    /// <summary>단순 글롭 매칭: '*' 만 와일드카드로 지원(대소문자 무시).</summary>
    public static bool MatchesGlob(string name, string glob)
    {
        string pattern = "^" + System.Text.RegularExpressions.Regex.Escape(glob).Replace("\\*", ".*") + "$";
        return System.Text.RegularExpressions.Regex.IsMatch(name, pattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }
}
