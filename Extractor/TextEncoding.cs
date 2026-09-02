using System.Security.Cryptography;
using System.Text;

namespace Extractor;

/// <summary>
/// 인코딩 규칙(§4.3): UTF-8 strict 디코딩 실패 시 CP949 폴백, BOM 제거.
/// 해시는 원본 바이트 기준(변환 전) — 인코딩 변환 여부와 무관하게 변경 감지가 맞도록.
/// </summary>
public static class TextEncodingHelper
{
    private static readonly UTF8Encoding Utf8Strict = new(false, true);
    private static readonly Encoding Cp949;

    static TextEncodingHelper()
    {
        Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);
        Cp949 = Encoding.GetEncoding(949);
    }

    /// <summary>파일을 읽어 (원본 바이트, 디코딩된 텍스트) 를 반환한다.</summary>
    public static (byte[] Bytes, string Text) ReadFile(string path)
    {
        var bytes = File.ReadAllBytes(path);
        string text;
        try
        {
            text = Utf8Strict.GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            text = Cp949.GetString(bytes);
        }
        if (text.Length > 0 && text[0] == '﻿')
        {
            text = text[1..];
        }
        return (bytes, text);
    }

    public static string Sha256Hex(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
