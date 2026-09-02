using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Extractor;

/// <summary>
/// Roslyn 구문 트리 기반 C# 멤버 단위 청킹(§4.4). 시맨틱 모델은 쓰지 않는다(참조 해석 불필요).
/// </summary>
public static class CSharpChunker
{
    private const int MemberSplitThreshold = 6000;
    private const int MemberSplitWindow = 4000;
    private const int MemberSplitOverlap = 400;
    private const int SmallMemberThreshold = 300;
    private const int MergedGroupMax = 1200;

    /// <summary>C# 파일을 청킹한다. 타입 선언이 하나도 없으면 null 을 반환해 텍스트 폴백을 유도한다.</summary>
    public static List<RawChunk>? Chunk(string relFile, string source)
    {
        SyntaxTree tree;
        try
        {
            tree = CSharpSyntaxTree.ParseText(source);
        }
        catch
        {
            return null;
        }

        var root = tree.GetRoot();
        var text = tree.GetText();
        var chunks = new List<RawChunk>();

        var topLevelTypes = root.DescendantNodes(n => n is not BaseTypeDeclarationSyntax)
            .OfType<BaseTypeDeclarationSyntax>()
            .Where(t => t.Parent is not BaseTypeDeclarationSyntax) // 최상위(네임스페이스 직속)만 — 중첩은 재귀로 처리
            .ToList();

        if (topLevelTypes.Count == 0) return null;

        foreach (var type in topLevelTypes)
        {
            VisitType(type, GetSimpleName(type), relFile, text, chunks);
        }

        return chunks.Count == 0 ? null : chunks;
    }

    private static void VisitType(BaseTypeDeclarationSyntax type, string dottedName, string relFile, SourceText text, List<RawChunk> output)
    {
        string ns = GetNamespace(type);
        string keyword = GetTypeKeyword(type);
        string bases = GetBaseListString(type);
        string header = $"// {relFile}\n// namespace {ns}\n// {keyword} {dottedName} : {bases}\n";

        if (type is EnumDeclarationSyntax)
        {
            var (start, startLine) = GetEffectiveStart(type, text);
            int endLine = LineOf(text, Math.Max(type.Span.End - 1, type.Span.Start));
            string body = text.ToString(TextSpan.FromBounds(start, type.Span.End));
            output.Add(new RawChunk(dottedName, "type", startLine, endLine, header + body));
            return;
        }

        if (type is not TypeDeclarationSyntax typeDecl) return; // 이론상 도달하지 않음(class/struct/record/interface/enum 만 존재)

        // 1) 타입 선언 헤더 청크 (멤버 본문 제외)
        {
            var (start, startLine) = GetEffectiveStart(typeDecl, text);
            int headerEnd = typeDecl.OpenBraceToken.IsKind(SyntaxKind.OpenBraceToken)
                ? typeDecl.OpenBraceToken.Span.End
                : typeDecl.Span.End;
            int endLine = LineOf(text, Math.Max(headerEnd - 1, start));
            string body = text.ToString(TextSpan.FromBounds(start, headerEnd));
            if (typeDecl.OpenBraceToken.IsKind(SyntaxKind.OpenBraceToken)) body += "\n    // ...\n}";
            output.Add(new RawChunk(dottedName, "type", startLine, endLine, header + body));
        }

        // 2) 멤버 순회: 중첩 타입은 재귀, 필드는 묶음, 나머지는 개별 청크(작은 것들은 후처리로 병합)
        var fieldTexts = new List<(string Text, int StartLine, int EndLine)>();
        var memberChunks = new List<RawChunk>();

        foreach (var member in typeDecl.Members)
        {
            switch (member)
            {
                case BaseTypeDeclarationSyntax nested:
                    VisitType(nested, dottedName + "." + GetSimpleName(nested), relFile, text, output);
                    break;

                case FieldDeclarationSyntax field:
                    {
                        var (start, startLine) = GetEffectiveStart(field, text);
                        int endLine = LineOf(text, Math.Max(field.Span.End - 1, start));
                        fieldTexts.Add((text.ToString(TextSpan.FromBounds(start, field.Span.End)), startLine, endLine));
                    }
                    break;

                default:
                    var built = BuildMemberChunk(member, dottedName, text);
                    if (built != null) memberChunks.Add(built);
                    break;
            }
        }

        if (fieldTexts.Count > 0)
        {
            string body = string.Join("\n\n", fieldTexts.Select(f => f.Text));
            output.Add(new RawChunk($"{dottedName}.<fields>", "fields", fieldTexts[0].StartLine, fieldTexts[^1].EndLine, header + body));
        }

        // 3) 크기 규칙 적용: 큰 멤버는 분할, 연속한 작은 멤버는 병합
        foreach (var mc in ExpandAndMerge(memberChunks, dottedName))
        {
            output.Add(mc with { Text = header + mc.Text });
        }
    }

    /// <summary>큰 멤버(>6000자) 분할 + 연속 작은 멤버(<300자) 병합(§4.4-5). header 는 아직 붙지 않은 상태로 처리.</summary>
    private static IEnumerable<RawChunk> ExpandAndMerge(List<RawChunk> members, string dottedName)
    {
        var result = new List<RawChunk>();
        var pendingSmall = new List<RawChunk>();
        int pendingLen = 0;

        void FlushPending()
        {
            if (pendingSmall.Count == 0) return;
            if (pendingSmall.Count == 1)
            {
                result.Add(pendingSmall[0]);
            }
            else
            {
                string names = string.Join(",", pendingSmall.Select(p => p.Symbol[(dottedName.Length + 1)..]));
                string body = string.Join("\n\n", pendingSmall.Select(p => p.Text));
                result.Add(new RawChunk($"{dottedName}.{{{names}}}", "members", pendingSmall[0].StartLine, pendingSmall[^1].EndLine, body));
            }
            pendingSmall.Clear();
            pendingLen = 0;
        }

        foreach (var m in members)
        {
            if (m.Text.Length > MemberSplitThreshold)
            {
                FlushPending();
                var lines = m.Text.Replace("\r\n", "\n").Split('\n');
                var windows = Windowing.Split(lines, MemberSplitWindow, MemberSplitOverlap);
                int k = 1;
                foreach (var w in windows)
                {
                    int sLine = m.StartLine + w.StartLineIndex;
                    int eLine = m.StartLine + w.EndLineIndex;
                    result.Add(new RawChunk($"{m.Symbol}#{k}", m.Kind, sLine, eLine, w.Text));
                    k++;
                }
                continue;
            }

            if (m.Text.Length < SmallMemberThreshold)
            {
                if (pendingLen + m.Text.Length > MergedGroupMax) FlushPending();
                pendingSmall.Add(m);
                pendingLen += m.Text.Length;
            }
            else
            {
                FlushPending();
                result.Add(m);
            }
        }
        FlushPending();
        return result;
    }

    private static RawChunk? BuildMemberChunk(MemberDeclarationSyntax member, string dottedName, SourceText text)
    {
        string? name = null;
        string kind = "method";

        switch (member)
        {
            case MethodDeclarationSyntax m:
                kind = "method";
                name = $"{m.Identifier.Text}({ParamTypes(m.ParameterList)})";
                break;
            case ConstructorDeclarationSyntax c:
                kind = "ctor";
                name = $".ctor({ParamTypes(c.ParameterList)})";
                break;
            case DestructorDeclarationSyntax d:
                kind = "ctor";
                name = $"~{d.Identifier.Text}";
                break;
            case PropertyDeclarationSyntax p:
                kind = "property";
                name = p.Identifier.Text;
                break;
            case IndexerDeclarationSyntax ix:
                kind = "property";
                name = $"this[{ParamTypes(ix.ParameterList)}]";
                break;
            case EventDeclarationSyntax ev:
                kind = "event";
                name = ev.Identifier.Text;
                break;
            case EventFieldDeclarationSyntax evf:
                kind = "event";
                name = string.Join(",", evf.Declaration.Variables.Select(v => v.Identifier.Text));
                break;
            case OperatorDeclarationSyntax op:
                kind = "operator";
                name = $"operator{op.OperatorToken.Text}({ParamTypes(op.ParameterList)})";
                break;
            case ConversionOperatorDeclarationSyntax cv:
                kind = "operator";
                name = $"{cv.ImplicitOrExplicitKeyword.Text} operator {cv.Type}({ParamTypes(cv.ParameterList)})";
                break;
            default:
                return null; // 알 수 없는 멤버 종류(예: 최상위 delegate) — 스킵
        }

        var (start, startLine) = GetEffectiveStart(member, text);
        int endLine = LineOf(text, Math.Max(member.Span.End - 1, start));
        string body = text.ToString(TextSpan.FromBounds(start, member.Span.End));
        return new RawChunk($"{dottedName}.{name}", kind, startLine, endLine, body);
    }

    private static string ParamTypes(ParameterListSyntax? list)
        => list == null ? "" : string.Join(",", list.Parameters.Select(p => p.Type?.ToString() ?? "var"));

    private static string ParamTypes(BracketedParameterListSyntax? list)
        => list == null ? "" : string.Join(",", list.Parameters.Select(p => p.Type?.ToString() ?? "var"));

    private static string GetSimpleName(BaseTypeDeclarationSyntax type) => type.Identifier.Text;

    private static string GetTypeKeyword(BaseTypeDeclarationSyntax type) => type switch
    {
        RecordDeclarationSyntax rec => rec.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) ? "record struct" : "record",
        ClassDeclarationSyntax => "class",
        StructDeclarationSyntax => "struct",
        InterfaceDeclarationSyntax => "interface",
        EnumDeclarationSyntax => "enum",
        _ => "type",
    };

    private static string GetBaseListString(BaseTypeDeclarationSyntax type)
        => type.BaseList == null ? "" : string.Join(", ", type.BaseList.Types.Select(t => t.ToString()));

    private static string GetNamespace(SyntaxNode node)
    {
        var names = new List<string>();
        var current = node.Parent;
        while (current != null)
        {
            if (current is BaseNamespaceDeclarationSyntax nsDecl)
            {
                names.Insert(0, nsDecl.Name.ToString());
            }
            current = current.Parent;
        }
        return string.Join(".", names);
    }

    /// <summary>
    /// 노드의 실효 시작 위치: leading trivia 안에서 맨 앞의 연속된 빈 줄(공백만 있는 줄)을 건너뛰고,
    /// 처음 내용이 있는 줄(주석/특성 등)부터를 청크에 포함한다(§4.4-4: leading trivia 포함).
    /// </summary>
    private static (int Pos, int Line) GetEffectiveStart(SyntaxNode node, SourceText text)
    {
        int leadingStart = node.FullSpan.Start;
        int nodeStart = node.SpanStart;
        if (leadingStart == nodeStart)
        {
            return (nodeStart, LineOf(text, nodeStart));
        }

        string leadingText = text.ToString(TextSpan.FromBounds(leadingStart, nodeStart));
        int lineStart = 0;
        int contentStart = -1;
        for (int p = 0; p <= leadingText.Length; p++)
        {
            if (p == leadingText.Length || leadingText[p] == '\n')
            {
                string line = leadingText[lineStart..p];
                if (!string.IsNullOrWhiteSpace(line))
                {
                    contentStart = lineStart;
                    break;
                }
                lineStart = p + 1;
            }
        }

        int effective = contentStart >= 0 ? leadingStart + contentStart : nodeStart;
        return (effective, LineOf(text, effective));
    }

    private static int LineOf(SourceText text, int position) => text.Lines.GetLineFromPosition(position).LineNumber + 1;
}
