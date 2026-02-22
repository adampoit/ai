#!/usr/bin/env dotnet run
// Skill Initializer - Creates a new skill from template
// Usage: dotnet run init-skill.cs <skill-name> --path <output-directory>
//
// Examples:
//     dotnet run init-skill.cs my-new-skill --path skills/public
//     dotnet run init-skill.cs my-api-helper --path skills/private

if (args.Length < 3 || args[1] != "--path")
{
    Console.WriteLine("Usage: dotnet run init-skill.cs <skill-name> --path <path>");
    Console.WriteLine();
    Console.WriteLine("Skill name requirements:");
    Console.WriteLine("  - Hyphen-case identifier (e.g., 'data-analyzer')");
    Console.WriteLine("  - Lowercase letters, digits, and hyphens only");
    Console.WriteLine("  - Max 64 characters");
    Console.WriteLine("  - Must match directory name exactly");
    Console.WriteLine();
    Console.WriteLine("Examples:");
    Console.WriteLine("  dotnet run init-skill.cs my-new-skill --path skills/public");
    Console.WriteLine("  dotnet run init-skill.cs my-api-helper --path skills/private");
    return 1;
}

var skillName = args[0];
var outputPath = args[2];

Console.WriteLine($"Initializing skill: {skillName}");
Console.WriteLine($"   Location: {outputPath}");
Console.WriteLine();

var result = InitSkill(skillName, outputPath);
return result != null ? 0 : 1;

string? InitSkill(string skillName, string path)
{
    var exampleAsset = """
        # Example Asset File

        This placeholder represents where asset files would be stored.
        Replace with actual asset files (templates, images, fonts, etc.) or delete if not needed.

        Asset files are NOT intended to be loaded into context, but rather used within
        the output the agent produces.

        ## Common Asset Types

        - Templates: .pptx, .docx, boilerplate directories
        - Images: .png, .jpg, .svg, .gif
        - Fonts: .ttf, .otf, .woff, .woff2
        - Boilerplate code: Project directories, starter files
        - Icons: .ico, .svg
        - Data files: .csv, .json, .xml, .yaml

        Note: This is a text placeholder. Actual assets can be any file type.
        """;

    var skillDir = Path.GetFullPath(Path.Combine(path, skillName));

    if (Directory.Exists(skillDir))
    {
        Console.WriteLine($"Error: Skill directory already exists: {skillDir}");
        return null;
    }

    try
    {
        Directory.CreateDirectory(skillDir);
        Console.WriteLine($"Created skill directory: {skillDir}");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Error creating directory: {ex.Message}");
        return null;
    }

    var skillTitle = TitleCase(skillName);
    var skillContent = GetSkillTemplate(skillName, skillTitle);

    try
    {
        File.WriteAllText(Path.Combine(skillDir, "SKILL.md"), skillContent);
        Console.WriteLine("Created SKILL.md");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Error creating SKILL.md: {ex.Message}");
        return null;
    }

    try
    {
        // Create scripts/ directory with example script
        var scriptsDir = Path.Combine(skillDir, "scripts");
        Directory.CreateDirectory(scriptsDir);
        File.WriteAllText(Path.Combine(scriptsDir, "example.cs"), GetExampleScript(skillName));
        Console.WriteLine("Created scripts/example.cs");

        // Create references/ directory with example reference doc
        var referencesDir = Path.Combine(skillDir, "references");
        Directory.CreateDirectory(referencesDir);
        File.WriteAllText(Path.Combine(referencesDir, "api-reference.md"), GetExampleReference(skillTitle));
        Console.WriteLine("Created references/api-reference.md");

        // Create assets/ directory with example asset placeholder
        var assetsDir = Path.Combine(skillDir, "assets");
        Directory.CreateDirectory(assetsDir);
        File.WriteAllText(Path.Combine(assetsDir, "example-asset.txt"), exampleAsset);
        Console.WriteLine("Created assets/example-asset.txt");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Error creating resource directories: {ex.Message}");
        return null;
    }

    Console.WriteLine();
    Console.WriteLine($"Skill '{skillName}' initialized successfully at {skillDir}");
    Console.WriteLine();
    Console.WriteLine("Next steps:");
    Console.WriteLine("1. Edit SKILL.md to complete the TODO items and update the description");
    Console.WriteLine("2. Customize or delete the example files in scripts/, references/, and assets/");
    Console.WriteLine("3. Run the validator when ready to check the skill structure");

    return skillDir;
}

string TitleCase(string skillName) =>
    string.Join(' ', skillName.Split('-').Select(w =>
        string.IsNullOrEmpty(w) ? w : char.ToUpper(w[0]) + w[1..]));

string GetSkillTemplate(string skillName, string skillTitle) => $@"---
name: {skillName}
description: [TODO: Complete and informative explanation of what the skill does and when to use it. Include WHEN to use this skill - specific scenarios, file types, or tasks that trigger it.]
---

# {skillTitle}

## Overview

[TODO: 1-2 sentences explaining what this skill enables]

## Structuring This Skill

[TODO: Choose the structure that best fits this skill's purpose. Common patterns:

**1. Workflow-Based** (best for sequential processes)
- Works well when there are clear step-by-step procedures
- Example: DOCX skill with ""Workflow Decision Tree"" → ""Reading"" → ""Creating"" → ""Editing""
- Structure: ## Overview → ## Workflow Decision Tree → ## Step 1 → ## Step 2...

**2. Task-Based** (best for tool collections)
- Works well when the skill offers different operations/capabilities
- Example: PDF skill with ""Quick Start"" → ""Merge PDFs"" → ""Split PDFs"" → ""Extract Text""
- Structure: ## Overview → ## Quick Start → ## Task Category 1 → ## Task Category 2...

**3. Reference/Guidelines** (best for standards or specifications)
- Works well for brand guidelines, coding standards, or requirements
- Example: Brand styling with ""Brand Guidelines"" → ""Colors"" → ""Typography"" → ""Features""
- Structure: ## Overview → ## Guidelines → ## Specifications → ## Usage...

**4. Capabilities-Based** (best for integrated systems)
- Works well when the skill provides multiple interrelated features
- Example: Product Management with ""Core Capabilities"" → numbered capability list
- Structure: ## Overview → ## Core Capabilities → ### 1. Feature → ### 2. Feature...

Patterns can be mixed and matched as needed. Most skills combine patterns (e.g., start with task-based, add workflow for complex operations).

Delete this entire ""Structuring This Skill"" section when done - it's just guidance.]

## [TODO: Replace with the first main section based on chosen structure]

[TODO: Add content here. See examples in existing skills:
- Code samples for technical skills
- Decision trees for complex workflows
- Concrete examples with realistic user requests
- References to scripts/templates/references as needed]

## Resources

This skill includes example resource directories that demonstrate how to organize different types of bundled resources:

### scripts/
Executable code (C#/Bash/etc.) that can be run directly to perform specific operations.

```bash
dotnet run ./scripts/<script>.cs --args
```

**Appropriate for:** C# file-based apps, shell scripts, or any executable code that performs automation, data processing, or specific operations.

**Note:** Scripts may be executed without loading into context, but can still be read by the agent for patching or environment adjustments.

### references/
Documentation and reference material intended to be loaded into context to inform the agent's process and thinking.

**Appropriate for:** In-depth documentation, API references, database schemas, comprehensive guides, or any detailed information that the agent should reference while working.

### assets/
Files not intended to be loaded into context, but rather used within the output the agent produces.

**Appropriate for:** Templates, boilerplate code, document templates, images, icons, fonts, or any files meant to be copied or used in the final output.

---

**Any unneeded directories can be deleted.** Not every skill requires all three types of resources.
";

string GetExampleScript(string skillName) => $@"#!/usr/bin/env dotnet run
#:package System.CommandLine@2.0.0-*

// Example helper script for {skillName}
// Usage:
//   dotnet run example.cs greet --name ""World""
//   dotnet run example.cs process --input data.txt --output result.json
//
// This template uses System.CommandLine 2.0 (preview) with the modern API.
// Replace with actual implementation or delete if not needed.

using System.CommandLine;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

// For .NET 10+, JSON serialization requires explicit TypeInfoResolver
var jsonOptions = new JsonSerializerOptions
{{
	WriteIndented = false,
	TypeInfoResolver = new DefaultJsonTypeInfoResolver()
}};

// Define options (use DefaultValueFactory for defaults in System.CommandLine 2.0)
var nameOption = new Option<string>(""--name"") {{ Description = ""Name to greet"", DefaultValueFactory = _ => ""World"" }};
var inputOption = new Option<string?>(""--input"") {{ Description = ""Input file path"" }};
var outputOption = new Option<string?>(""--output"") {{ Description = ""Output file path"" }};

// Define commands - use Options.Add() in System.CommandLine 2.0
var greetCommand = new Command(""greet"", ""Greet someone by name"");
greetCommand.Options.Add(nameOption);

var processCommand = new Command(""process"", ""Process an input file"");
processCommand.Options.Add(inputOption);
processCommand.Options.Add(outputOption);

// Root command with subcommands
var rootCommand = new RootCommand(""Example CLI for {skillName}"");
rootCommand.Subcommands.Add(greetCommand);
rootCommand.Subcommands.Add(processCommand);

// Define actions using SetAction (System.CommandLine 2.0 API)
greetCommand.SetAction((parseResult, cancellationToken) =>
{{
	var name = parseResult.GetValue(nameOption);
	WriteJson(new {{ message = $""Hello, {{name}}!"" }});
	return Task.FromResult(0);
}});

processCommand.SetAction(async (parseResult, cancellationToken) =>
{{
	var input = parseResult.GetValue(inputOption);
	var output = parseResult.GetValue(outputOption);

	if (string.IsNullOrEmpty(input))
	{{
		WriteJson(new {{ error = ""Missing --input option"" }});
		return 1;
	}}

	// TODO: Replace with actual processing logic
	try
	{{
		var content = await File.ReadAllTextAsync(input, cancellationToken);
		var result = new {{ input_file = input, line_count = content.Split('\n').Length }};

		if (!string.IsNullOrEmpty(output))
		{{
			await File.WriteAllTextAsync(output, JsonSerializer.Serialize(result, result.GetType(), jsonOptions), cancellationToken);
			WriteJson(new {{ success = true, output_file = output }});
		}}
		else
		{{
			WriteJson(result);
		}}
		return 0;
	}}
	catch (Exception ex)
	{{
		WriteJson(new {{ error = ex.Message }});
		return 1;
	}}
}});

return await rootCommand.Parse(args).InvokeAsync();

void WriteJson(object obj) =>
	Console.WriteLine(JsonSerializer.Serialize(obj, obj.GetType(), jsonOptions));
";

string GetExampleReference(string skillTitle) => $@"# Reference Documentation for {skillTitle}

This is a placeholder for detailed reference documentation.
Replace with actual reference content or delete if not needed.

## When Reference Docs Are Useful

Reference docs are ideal for:
- Comprehensive API documentation
- Detailed workflow guides
- Complex multi-step processes
- Information too lengthy for main SKILL.md
- Content that's only needed for specific use cases

## Structure Suggestions

### API Reference Example
- Overview
- Authentication
- Endpoints with examples
- Error codes
- Rate limits

### Workflow Guide Example
- Prerequisites
- Step-by-step instructions
- Common patterns
- Troubleshooting
- Best practices
";
