#!/usr/bin/env dotnet run
#:package AngleSharp@1.4.0
#:package System.CommandLine@2.0.3

using System.CommandLine;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using AngleSharp.Dom;
using AngleSharp.Html.Dom;
using AngleSharp.Html.Parser;

var shareUrlArgument = new Argument<string>("share_url")
{
    Description = "Public ChatGPT share URL (https://chatgpt.com/share/...)"
};

var outputOption = new Option<string?>("--output")
{
    Description = "Optional output markdown file path"
};

var includeToolTurnsOption = new Option<bool>("--include-tool-turns")
{
    Description = "Include tool role turns in output"
};

var includeInternalActionsOption = new Option<bool>("--include-internal-actions")
{
    Description = "Include assistant internal tool-action payloads"
};

var includeReasoningOption = new Option<bool>("--include-reasoning")
{
    Description = "Include reasoning recap/thought turns"
};

var root = new RootCommand("Convert a ChatGPT share URL into Markdown")
{
    shareUrlArgument,
    outputOption,
    includeToolTurnsOption,
    includeInternalActionsOption,
    includeReasoningOption,
};

root.SetAction(async (parseResult, cancellationToken) =>
{
    var shareUrl = parseResult.GetValue(shareUrlArgument) ?? string.Empty;
    var options = new ParsedOptions(
        ShareUrl: shareUrl,
        OutputPath: parseResult.GetValue(outputOption),
        IncludeToolTurns: parseResult.GetValue(includeToolTurnsOption),
        IncludeInternalActions: parseResult.GetValue(includeInternalActionsOption),
        IncludeReasoning: parseResult.GetValue(includeReasoningOption)
    );

    try
    {
        await App.ExportAsync(options, cancellationToken);
        return 0;
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Error: {ex.Message}");
        return 1;
    }
});

return await root.Parse(args).InvokeAsync();

static class App
{
static readonly Dictionary<string, string> DefaultHeaders = new()
{
    ["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    ["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    ["Accept-Language"] = "en-US,en;q=0.9",
    ["Referer"] = "https://chatgpt.com/",
};

static readonly HashSet<string> InternalActionKeys =
[
    "search_query",
    "open",
    "find",
    "click",
    "response_length",
    "navigate",
    "read",
    "image_query",
];

static readonly Regex PrivateUseRegex = new(@"[\uE000-\uF8FF]");
static readonly Regex CitationTokenRegex = new(@"\s*(?:citeturn|navlist|turn\d+\w*)[^,\s]*,?");

public static async Task ExportAsync(ParsedOptions options, CancellationToken cancellationToken)
{
    ValidateShareUrl(options.ShareUrl);

    var html = await FetchShareHtmlAsync(options.ShareUrl, cancellationToken);

    Conversation conversation;
    Exception? modernError = null;

    try
    {
        conversation = ParseModernShare(html, options);
    }
    catch (Exception ex)
    {
        modernError = ex;
        try
        {
            conversation = ParseLegacyShare(html, options);
        }
        catch (Exception legacyError)
        {
            throw new Exception($"Modern parse failed: {modernError.Message}; legacy parse failed: {legacyError.Message}");
        }
    }

    var markdown = ToMarkdown(conversation);
    if (!string.IsNullOrWhiteSpace(options.OutputPath))
    {
        var absolutePath = Path.GetFullPath(options.OutputPath);
        var directory = Path.GetDirectoryName(absolutePath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        await File.WriteAllTextAsync(absolutePath, markdown, Encoding.UTF8, cancellationToken);
        Console.WriteLine(absolutePath);
    }
    else
    {
        Console.Write(markdown);
    }
}

static void ValidateShareUrl(string shareUrl)
{
    if (!Uri.TryCreate(shareUrl, UriKind.Absolute, out var uri))
    {
        throw new ArgumentException("Share URL must be a valid absolute URL.");
    }

    if (uri.Scheme is not ("http" or "https"))
    {
        throw new ArgumentException("Share URL must use http:// or https://.");
    }

    if (uri.Host is not ("chatgpt.com" or "www.chatgpt.com"))
    {
        throw new ArgumentException("Share URL host must be chatgpt.com.");
    }

    if (!uri.AbsolutePath.StartsWith("/share/", StringComparison.Ordinal))
    {
        throw new ArgumentException("Share URL path must start with /share/.");
    }
}

static async Task<string> FetchShareHtmlAsync(string shareUrl, CancellationToken cancellationToken)
{
    using var client = new HttpClient
    {
        Timeout = TimeSpan.FromSeconds(30),
    };

    using var request = new HttpRequestMessage(HttpMethod.Get, shareUrl);
    foreach (var (name, value) in DefaultHeaders)
    {
        request.Headers.TryAddWithoutValidation(name, value);
    }

    HttpResponseMessage response;
    try
    {
        response = await client.SendAsync(request, cancellationToken);
    }
    catch (Exception ex)
    {
        throw new Exception($"Failed to fetch share URL: {ex.Message}", ex);
    }

    if (response.StatusCode == HttpStatusCode.Forbidden)
    {
        throw new Exception("Share URL is not accessible (HTTP 403). Confirm this is a public chatgpt.com/share link.");
    }

    if (!response.IsSuccessStatusCode)
    {
        throw new Exception($"Failed to fetch share URL (HTTP {(int)response.StatusCode}).");
    }

    return await response.Content.ReadAsStringAsync(cancellationToken);
}

static Conversation ParseModernShare(string html, ParsedOptions options)
{
    var loader = ExtractLoaderPayload(html) ?? throw new Exception("Modern share payload not found.");
    var decoded = DecodeLoader(loader);
    var data = FindConversationData(decoded) ?? throw new Exception("Conversation data not found in modern payload.");
    return BuildConversation(data, options);
}

static Conversation ParseLegacyShare(string html, ParsedOptions options)
{
    var payload = ExtractLegacyPayload(html) ?? throw new Exception("Legacy share payload not found.");
    var props = GetDictionary(payload, "props");
    var pageProps = GetDictionary(props, "pageProps");
    var serverResponse = GetDictionary(pageProps, "serverResponse");

    if (serverResponse.GetValueOrDefault("data") is not Dictionary<string, object?> data)
    {
        throw new Exception("Conversation data not found in legacy payload.");
    }

    return BuildConversation(data, options);
}

static Conversation BuildConversation(Dictionary<string, object?> data, ParsedOptions options)
{
    var model = GetDictionary(data, "model");
    return new Conversation(
        ShareId: ParseShareId(options.ShareUrl),
        SourceUrl: options.ShareUrl,
        Title: GetString(data, "title") ?? "ChatGPT conversation",
        UpdatedAt: GetDouble(data, "update_time"),
        ModelSlug: GetString(model, "slug"),
        Turns: ParseTurns(data, options)
    );
}

static List<Turn> ParseTurns(Dictionary<string, object?> data, ParsedOptions options)
{
    var mapping = GetDictionary(data, "mapping");
    var linearConversation = GetList(data, "linear_conversation");

    var turns = new List<Turn>();
    var seenMessageIds = new HashSet<string>(StringComparer.Ordinal);

    void MaybeAddMessage(Dictionary<string, object?> message)
    {
        var turn = ParseMessage(message, options);
        if (turn is null)
        {
            return;
        }

        if (!string.IsNullOrWhiteSpace(turn.MessageId) && !seenMessageIds.Add(turn.MessageId))
        {
            return;
        }

        turns.Add(turn);
    }

    foreach (var entryObject in linearConversation)
    {
        if (entryObject is not Dictionary<string, object?> entry)
        {
            continue;
        }

        if (entry.GetValueOrDefault("message") is Dictionary<string, object?> inlineMessage)
        {
            MaybeAddMessage(inlineMessage);
            continue;
        }

        var nodeId = GetString(entry, "id");
        if (string.IsNullOrWhiteSpace(nodeId))
        {
            continue;
        }

        if (mapping.GetValueOrDefault(nodeId) is Dictionary<string, object?> node &&
            node.GetValueOrDefault("message") is Dictionary<string, object?> resolvedMessage)
        {
            MaybeAddMessage(resolvedMessage);
        }
    }

    if (turns.Count > 0)
    {
        return turns;
    }

    var fallback = new List<Turn>();
    foreach (var nodeObject in mapping.Values)
    {
        if (nodeObject is not Dictionary<string, object?> node)
        {
            continue;
        }

        if (node.GetValueOrDefault("message") is not Dictionary<string, object?> message)
        {
            continue;
        }

        var turn = ParseMessage(message, options);
        if (turn is null)
        {
            continue;
        }

        if (!string.IsNullOrWhiteSpace(turn.MessageId) && !seenMessageIds.Add(turn.MessageId))
        {
            continue;
        }

        fallback.Add(turn);
    }

    fallback.Sort((a, b) => Nullable.Compare(a.CreateTime, b.CreateTime));
    return fallback;
}

static Turn? ParseMessage(Dictionary<string, object?> message, ParsedOptions options)
{
    var author = GetDictionary(message, "author");
    var role = GetString(author, "role");

    if (role == "system")
    {
        return null;
    }

    if (role == "tool" && !options.IncludeToolTurns)
    {
        return null;
    }

    var content = ParseMessageContent(message, options);
    if (string.IsNullOrWhiteSpace(content))
    {
        return null;
    }

    return new Turn(
        Role: RoleLabel(role),
        Content: content,
        CreateTime: GetDouble(message, "create_time"),
        MessageId: GetString(message, "id")
    );
}

static string ParseMessageContent(Dictionary<string, object?> message, ParsedOptions options)
{
    var content = GetDictionary(message, "content");
    var contentType = GetString(content, "content_type");

    if (contentType == "text")
    {
        return ParseTextParts(content.GetValueOrDefault("parts"));
    }

    if (contentType == "multimodal_text")
    {
        return ParseMultimodalParts(content.GetValueOrDefault("parts"));
    }

    if (contentType == "code")
    {
        var language = GetString(content, "language") ?? string.Empty;
        if (language == "unknown")
        {
            language = string.Empty;
        }

        var code = (GetString(content, "text") ?? string.Empty).TrimEnd('\n', '\r');
        if (string.IsNullOrWhiteSpace(code))
        {
            return string.Empty;
        }

        if (!options.IncludeInternalActions && LooksLikeInternalActionPayload(code))
        {
            return string.Empty;
        }

        return $"```{language}\n{code}\n```";
    }

    if (contentType == "tool_response")
    {
        var output = content.GetValueOrDefault("output");
        if (output is string outputText)
        {
            return CleanText(outputText);
        }

        if (output is Dictionary<string, object?> outputObject)
        {
            return "```json\n" + ToIndentedJson(outputObject) + "\n```";
        }
    }

    if (contentType == "thoughts")
    {
        if (!options.IncludeReasoning)
        {
            return string.Empty;
        }

        var lines = new List<string>();
        if (content.GetValueOrDefault("thoughts") is List<object?> thoughtList)
        {
            foreach (var thoughtObject in thoughtList)
            {
                if (thoughtObject is not Dictionary<string, object?> thought)
                {
                    continue;
                }

                var summary = GetString(thought, "summary");
                var detail = GetString(thought, "content");
                var combined = string.Join(": ", new[] { summary, detail }.Where(x => !string.IsNullOrWhiteSpace(x)));
                var cleaned = CleanText(combined);
                if (!string.IsNullOrWhiteSpace(cleaned))
                {
                    lines.Add(cleaned);
                }
            }
        }

        return string.Join("\n\n", lines);
    }

    if (contentType == "reasoning_recap")
    {
        if (!options.IncludeReasoning)
        {
            return string.Empty;
        }

        var recap = CleanText(GetString(content, "content") ?? string.Empty);
        return string.IsNullOrWhiteSpace(recap) ? string.Empty : $"_{recap}_";
    }

    if (contentType == "model_editable_context")
    {
        return CleanText(GetString(content, "model_set_context") ?? string.Empty);
    }

    var genericParts = ParseTextParts(content.GetValueOrDefault("parts"));
    if (!string.IsNullOrWhiteSpace(genericParts))
    {
        return genericParts;
    }

    if (content.GetValueOrDefault("output") is string outputFallback)
    {
        return CleanText(outputFallback);
    }

    return string.Empty;
}

static string ParseTextParts(object? parts)
{
    if (parts is not List<object?> list)
    {
        return string.Empty;
    }

    var rendered = new List<string>();
    foreach (var part in list)
    {
        if (part is not string text)
        {
            continue;
        }

        var candidate = CleanText(text);
        if (string.IsNullOrWhiteSpace(candidate))
        {
            continue;
        }

        if (candidate.StartsWith("{", StringComparison.Ordinal) && candidate.EndsWith("}", StringComparison.Ordinal))
        {
            try
            {
                var node = JsonNode.Parse(candidate) as JsonObject;
                if (node is not null)
                {
                    var response = node["response"]?.GetValue<string>();
                    var content = node["content"]?.GetValue<string>();
                    candidate = CleanText(response ?? content ?? candidate);
                }
            }
            catch
            {
            }
        }

        if (!string.IsNullOrWhiteSpace(candidate))
        {
            rendered.Add(candidate);
        }
    }

    return string.Join("\n\n", rendered);
}

static string ParseMultimodalParts(object? parts)
{
    if (parts is not List<object?> list)
    {
        return string.Empty;
    }

    var segments = new List<string>();
    foreach (var part in list)
    {
        if (part is string text)
        {
            var cleaned = CleanText(text);
            if (!string.IsNullOrWhiteSpace(cleaned))
            {
                segments.Add(cleaned);
            }

            continue;
        }

        if (part is not Dictionary<string, object?> item)
        {
            continue;
        }

        var partType = GetString(item, "content_type") ?? GetString(item, "type");
        if (partType == "text")
        {
            var textField = item.GetValueOrDefault("text");
            if (textField is string textValue)
            {
                var cleaned = CleanText(textValue);
                if (!string.IsNullOrWhiteSpace(cleaned))
                {
                    segments.Add(cleaned);
                }
            }
            else if (textField is List<object?> textList)
            {
                foreach (var textObject in textList)
                {
                    if (textObject is not string textItem)
                    {
                        continue;
                    }

                    var cleaned = CleanText(textItem);
                    if (!string.IsNullOrWhiteSpace(cleaned))
                    {
                        segments.Add(cleaned);
                    }
                }
            }
        }
        else if (partType is "image_asset_pointer" or "file")
        {
            var pointer = GetString(item, "asset_pointer");
            if (!string.IsNullOrWhiteSpace(pointer))
            {
                segments.Add($"[Asset: {pointer}]");
            }
        }
    }

    return string.Join("\n\n", segments);
}

static bool LooksLikeInternalActionPayload(string code)
{
    try
    {
        var node = JsonNode.Parse(code) as JsonObject;
        if (node is null)
        {
            return false;
        }

        var keys = node.Select(x => x.Key).ToList();
        return keys.Count > 0 && keys.All(InternalActionKeys.Contains);
    }
    catch
    {
        return false;
    }
}

static string ToMarkdown(Conversation conversation)
{
    var lines = new List<string>
    {
        $"# {conversation.Title}",
        string.Empty,
        $"- Source: {conversation.SourceUrl}",
    };

    var updated = FormatTimestamp(conversation.UpdatedAt);
    if (!string.IsNullOrWhiteSpace(updated))
    {
        lines.Add($"- Updated: {updated}");
    }

    if (!string.IsNullOrWhiteSpace(conversation.ModelSlug))
    {
        lines.Add($"- Model: {conversation.ModelSlug}");
    }

    lines.Add(string.Empty);

    foreach (var turn in conversation.Turns)
    {
        lines.Add($"## {turn.Role}");
        lines.Add(string.Empty);
        lines.Add(string.IsNullOrWhiteSpace(turn.Content) ? "_(empty)_" : turn.Content.Trim());
        lines.Add(string.Empty);
    }

    if (conversation.Turns.Count == 0)
    {
        lines.Add("_(No message turns were detected in the shared conversation.)_");
        lines.Add(string.Empty);
    }

    return string.Join("\n", lines).TrimEnd() + "\n";
}

static string? FormatTimestamp(double? epochSeconds)
{
    if (epochSeconds is null)
    {
        return null;
    }

    try
    {
        var milliseconds = checked((long)Math.Round(epochSeconds.Value * 1000.0, MidpointRounding.AwayFromZero));
        var utc = DateTimeOffset.FromUnixTimeMilliseconds(milliseconds).UtcDateTime;
        return utc.ToString("yyyy-MM-dd HH:mm:ss 'UTC'", CultureInfo.InvariantCulture);
    }
    catch
    {
        return null;
    }
}

static string CleanText(string text)
{
    if (string.IsNullOrEmpty(text))
    {
        return string.Empty;
    }

    var normalized = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
    normalized = PrivateUseRegex.Replace(normalized, string.Empty);

    var lines = normalized.Split('\n');
    for (var i = 0; i < lines.Length; i++)
    {
        lines[i] = CitationTokenRegex.Replace(lines[i], string.Empty).TrimEnd();
    }

    return string.Join("\n", lines).Trim();
}

static string ToIndentedJson(object? value)
{
    using var stream = new MemoryStream();
    using var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true });
    WriteJsonValue(writer, value);
    writer.Flush();
    return Encoding.UTF8.GetString(stream.ToArray());
}

static void WriteJsonValue(Utf8JsonWriter writer, object? value)
{
    switch (value)
    {
        case null:
            writer.WriteNullValue();
            return;
        case string s:
            writer.WriteStringValue(s);
            return;
        case bool b:
            writer.WriteBooleanValue(b);
            return;
        case int i:
            writer.WriteNumberValue(i);
            return;
        case long l:
            writer.WriteNumberValue(l);
            return;
        case float f:
            writer.WriteNumberValue(f);
            return;
        case double d:
            writer.WriteNumberValue(d);
            return;
        case decimal m:
            writer.WriteNumberValue(m);
            return;
        case Dictionary<string, object?> obj:
            writer.WriteStartObject();
            foreach (var (key, child) in obj)
            {
                writer.WritePropertyName(key);
                WriteJsonValue(writer, child);
            }

            writer.WriteEndObject();
            return;
        case List<object?> arr:
            writer.WriteStartArray();
            foreach (var item in arr)
            {
                WriteJsonValue(writer, item);
            }

            writer.WriteEndArray();
            return;
        default:
            writer.WriteStringValue(value.ToString());
            return;
    }
}

static JsonArray? ExtractLoaderPayload(string html)
{
    var scripts = ParseHtml(html).QuerySelectorAll("script");
    foreach (var script in scripts)
    {
        var body = script.TextContent ?? string.Empty;
        if (!body.Contains("streamController.enqueue", StringComparison.Ordinal))
        {
            continue;
        }

        var start = 0;
        while (true)
        {
            var anchor = body.IndexOf("streamController.enqueue(", start, StringComparison.Ordinal);
            if (anchor < 0)
            {
                break;
            }

            anchor += "streamController.enqueue(".Length;
            if (!TryReadJsonStringLiteral(body, anchor, out var literal, out var nextIndex))
            {
                start = Math.Min(anchor + 1, body.Length);
                continue;
            }

            string chunk;
            try
            {
                var literalNode = JsonNode.Parse(literal);
                chunk = literalNode?.GetValue<string>() ?? string.Empty;
            }
            catch
            {
                start = nextIndex;
                continue;
            }

            chunk = chunk.Trim();
            if (!chunk.StartsWith("[", StringComparison.Ordinal))
            {
                start = nextIndex;
                continue;
            }

            try
            {
                if (JsonNode.Parse(chunk) is JsonArray array)
                {
                    return array;
                }
            }
            catch
            {
            }

            start = nextIndex;
        }
    }

    return null;
}

static bool TryReadJsonStringLiteral(string text, int startIndex, out string literal, out int nextIndex)
{
    literal = string.Empty;
    nextIndex = startIndex;

    var i = startIndex;
    while (i < text.Length && char.IsWhiteSpace(text[i]))
    {
        i++;
    }

    if (i >= text.Length || text[i] != '"')
    {
        nextIndex = i;
        return false;
    }

    var j = i + 1;
    var escaped = false;
    while (j < text.Length)
    {
        var c = text[j];
        if (escaped)
        {
            escaped = false;
        }
        else if (c == '\\')
        {
            escaped = true;
        }
        else if (c == '"')
        {
            literal = text.Substring(i, j - i + 1);
            nextIndex = j + 1;
            return true;
        }

        j++;
    }

    nextIndex = text.Length;
    return false;
}

static Dictionary<string, object?> DecodeLoader(JsonArray loader)
{
    var cache = new Dictionary<int, object?>();

    string DecodeKey(string raw)
    {
        if (raw.Length > 1 && raw[0] == '_' && int.TryParse(raw.AsSpan(1), out var idx) && idx >= 0 && idx < loader.Count)
        {
            if (loader[idx] is JsonValue stringNode && stringNode.TryGetValue<string>(out var decodedKey) && !string.IsNullOrEmpty(decodedKey))
            {
                return decodedKey;
            }
        }

        return raw;
    }

    object? Resolve(JsonNode? node)
    {
        if (TryReferenceIndex(node, out var referenceIndex) && referenceIndex >= 0 && referenceIndex < loader.Count)
        {
            if (cache.TryGetValue(referenceIndex, out var cached))
            {
                return cached;
            }

            cache[referenceIndex] = null;
            var resolved = Resolve(loader[referenceIndex]);
            cache[referenceIndex] = resolved;
            return resolved;
        }

        return node switch
        {
            null => null,
            JsonObject obj => obj.ToDictionary(pair => DecodeKey(pair.Key), pair => Resolve(pair.Value)),
            JsonArray arr => arr.Select(Resolve).ToList(),
            JsonValue val => ReadJsonValue(val),
            _ => null,
        };
    }

    var decoded = new Dictionary<string, object?>();
    for (var i = 1; i + 1 < loader.Count; i += 2)
    {
        if (loader[i] is not JsonValue keyNode || !keyNode.TryGetValue<string>(out var key) || string.IsNullOrEmpty(key))
        {
            continue;
        }

        if (!decoded.ContainsKey(key))
        {
            decoded[key] = Resolve(loader[i + 1]);
        }
    }

    return decoded;
}

static bool TryReferenceIndex(JsonNode? node, out int index)
{
    index = default;
    if (node is not JsonValue value)
    {
        return false;
    }

    if (value.TryGetValue<int>(out var intValue))
    {
        index = intValue;
        return true;
    }

    if (value.TryGetValue<long>(out var longValue) && longValue is >= int.MinValue and <= int.MaxValue)
    {
        index = (int)longValue;
        return true;
    }

    return false;
}

static object? ReadJsonValue(JsonValue value)
{
    if (value.TryGetValue<string>(out var s))
    {
        return s;
    }

    if (value.TryGetValue<bool>(out var b))
    {
        return b;
    }

    if (value.TryGetValue<int>(out var i))
    {
        return i;
    }

    if (value.TryGetValue<long>(out var l))
    {
        return l;
    }

    if (value.TryGetValue<double>(out var d))
    {
        return d;
    }

    return value.ToJsonString();
}

static Dictionary<string, object?>? FindConversationData(object? value)
{
    if (value is Dictionary<string, object?> dictionary)
    {
        if (dictionary.ContainsKey("title") && dictionary.ContainsKey("mapping") && dictionary.ContainsKey("linear_conversation"))
        {
            return dictionary;
        }

        foreach (var nested in dictionary.Values)
        {
            var found = FindConversationData(nested);
            if (found is not null)
            {
                return found;
            }
        }
    }
    else if (value is List<object?> list)
    {
        foreach (var item in list)
        {
            var found = FindConversationData(item);
            if (found is not null)
            {
                return found;
            }
        }
    }

    return null;
}

static Dictionary<string, object?>? ExtractLegacyPayload(string html)
{
    var scripts = ParseHtml(html).QuerySelectorAll("script");
    foreach (var script in scripts)
    {
        if (!string.Equals(script.GetAttribute("id"), "__NEXT_DATA__", StringComparison.Ordinal))
        {
            continue;
        }

        try
        {
            var root = JsonNode.Parse(script.TextContent ?? string.Empty);
            return NodeToObject(root) as Dictionary<string, object?>;
        }
        catch
        {
            return null;
        }
    }

    return null;
}

static object? NodeToObject(JsonNode? node)
{
    return node switch
    {
        null => null,
        JsonObject obj => obj.ToDictionary(pair => pair.Key, pair => NodeToObject(pair.Value)),
        JsonArray arr => arr.Select(NodeToObject).ToList(),
        JsonValue val => ReadJsonValue(val),
        _ => null,
    };
}

static IHtmlDocument ParseHtml(string html)
{
    var parser = new HtmlParser();
    return parser.ParseDocument(html);
}

static string ParseShareId(string shareUrl)
{
    var uri = new Uri(shareUrl);
    var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
    return segments.Length >= 2 && string.Equals(segments[0], "share", StringComparison.Ordinal)
        ? segments[1]
        : "shared";
}

static string RoleLabel(string? role)
{
    return role switch
    {
        "user" => "User",
        "tool" => "Tool",
        _ => "Assistant",
    };
}

static Dictionary<string, object?> GetDictionary(Dictionary<string, object?> source, string key)
{
    return source.GetValueOrDefault(key) as Dictionary<string, object?> ?? new Dictionary<string, object?>();
}

static List<object?> GetList(Dictionary<string, object?> source, string key)
{
    return source.GetValueOrDefault(key) as List<object?> ?? [];
}

static string? GetString(Dictionary<string, object?> source, string key)
{
    return source.GetValueOrDefault(key) as string;
}

static double? GetDouble(Dictionary<string, object?> source, string key)
{
    return source.GetValueOrDefault(key) switch
    {
        double d => d,
        float f => f,
        decimal m => (double)m,
        int i => i,
        long l => l,
        _ => null,
    };
}
}

sealed record ParsedOptions(
    string ShareUrl,
    string? OutputPath,
    bool IncludeToolTurns,
    bool IncludeInternalActions,
    bool IncludeReasoning
);

sealed record Turn(string Role, string Content, double? CreateTime, string? MessageId);

sealed record Conversation(
    string ShareId,
    string SourceUrl,
    string Title,
    double? UpdatedAt,
    string? ModelSlug,
    List<Turn> Turns
);
