#!/usr/bin/env dotnet run
// Skill Validator - Validates a skill directory structure and SKILL.md
// Usage: dotnet run validate-skill.cs <skill-directory>

#:package YamlDotNet@16.*

using System.Text.RegularExpressions;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

if (args.Length < 1)
{
    Console.WriteLine("Usage: dotnet run validate-skill.cs <skill-directory>");
    return 1;
}

var skillPath = Path.GetFullPath(args[0]);
var (isValid, message) = ValidateSkill(skillPath);
Console.WriteLine(message);
return isValid ? 0 : 1;

static (bool IsValid, string Message) ValidateSkill(string skillPath)
{
    if (!Directory.Exists(skillPath))
        return (false, $"Skill directory not found: {skillPath}");

    var skillMdPath = Path.Combine(skillPath, "SKILL.md");
    if (!File.Exists(skillMdPath))
        return (false, "SKILL.md not found");

    var content = File.ReadAllText(skillMdPath);
    if (!content.StartsWith("---"))
        return (false, "No YAML frontmatter found");

    var frontmatterMatch = Regex.Match(content, @"^---\n(.*?)\n---", RegexOptions.Singleline);
    if (!frontmatterMatch.Success)
        return (false, "Invalid frontmatter format");

    var frontmatterText = frontmatterMatch.Groups[1].Value;

    Dictionary<string, object>? frontmatter;
    try
    {
        var deserializer = new DeserializerBuilder()
            .WithNamingConvention(HyphenatedNamingConvention.Instance)
            .Build();
        frontmatter = deserializer.Deserialize<Dictionary<string, object>>(frontmatterText);
        if (frontmatter == null)
            return (false, "Frontmatter must be a YAML dictionary");
    }
    catch (Exception ex)
    {
        return (false, $"Invalid YAML in frontmatter: {ex.Message}");
    }

    var allowedProperties = new HashSet<string> { "name", "description", "license", "allowed-tools", "metadata" };
    var unexpectedKeys = frontmatter.Keys.Where(k => !allowedProperties.Contains(k)).ToList();
    if (unexpectedKeys.Count > 0)
    {
        return (false,
            $"Unexpected key(s) in SKILL.md frontmatter: {string.Join(", ", unexpectedKeys.OrderBy(k => k))}. " +
            $"Allowed properties are: {string.Join(", ", allowedProperties.OrderBy(k => k))}");
    }

    if (!frontmatter.ContainsKey("name"))
        return (false, "Missing 'name' in frontmatter");
    if (!frontmatter.ContainsKey("description"))
        return (false, "Missing 'description' in frontmatter");

    var name = frontmatter["name"]?.ToString()?.Trim() ?? "";
    if (!string.IsNullOrEmpty(name))
    {
        if (!Regex.IsMatch(name, @"^[a-z0-9-]+$"))
            return (false, $"Name '{name}' should be hyphen-case (lowercase letters, digits, and hyphens only)");
        if (name.StartsWith('-') || name.EndsWith('-') || name.Contains("--"))
            return (false, $"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens");
        if (name.Length > 64)
            return (false, $"Name is too long ({name.Length} characters). Maximum is 64 characters.");
    }

    var description = frontmatter["description"]?.ToString()?.Trim() ?? "";
    if (!string.IsNullOrEmpty(description))
    {
        if (description.Contains('<') || description.Contains('>'))
            return (false, "Description cannot contain angle brackets (< or >)");
        if (description.Length > 1024)
            return (false, $"Description is too long ({description.Length} characters). Maximum is 1024 characters.");
    }

    return (true, "Skill is valid!");
}
