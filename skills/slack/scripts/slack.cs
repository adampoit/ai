#!/usr/bin/env dotnet run
#:package SlackNet@0.16.2
#:package System.CommandLine@2.0.0-*

// Slack CLI - Search messages or read thread replies
// Usage:
//   dotnet run slack.cs search --query "deployment issue" [--max-results 10]
//   dotnet run slack.cs thread --channel C123 --thread-ts 1234567890.123456
//   dotnet run slack.cs thread --permalink "https://example.com/archives/C123/p1234567890123456"
//
// Environment:
//   SLACK_API_TOKEN - Required. Bot or user OAuth token with appropriate scopes.

using System.CommandLine;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using System.Text.RegularExpressions;
using SlackNet;
using SlackNet.WebApi;

var jsonOptions = new JsonSerializerOptions
{
	WriteIndented = false,
	TypeInfoResolver = new DefaultJsonTypeInfoResolver()
};

var queryOption = new Option<string?>("--query") { Description = "Search query for messages" };
var maxResultsOption = new Option<int>("--max-results") { Description = "Maximum results to return", DefaultValueFactory = _ => 10 };
var channelOption = new Option<string?>("--channel") { Description = "Channel ID for thread or to narrow searches" };
var threadTsOption = new Option<string?>("--thread-ts") { Description = "Timestamp of parent message for reading thread replies" };
var permalinkOption = new Option<string?>("--permalink") { Description = "Slack permalink URL to extract channel and thread_ts" };

var searchCommand = new Command("search", "Search Slack messages matching a query");
searchCommand.Options.Add(queryOption);
searchCommand.Options.Add(maxResultsOption);

var threadCommand = new Command("thread", "Read all replies in a Slack thread");
threadCommand.Options.Add(channelOption);
threadCommand.Options.Add(threadTsOption);
threadCommand.Options.Add(permalinkOption);
threadCommand.Options.Add(maxResultsOption);

var rootCommand = new RootCommand("Search Slack messages or read thread replies");
rootCommand.Subcommands.Add(searchCommand);
rootCommand.Subcommands.Add(threadCommand);

searchCommand.SetAction(async (parseResult, cancellationToken) =>
{
	var query = parseResult.GetValue(queryOption);
	var maxResults = parseResult.GetValue(maxResultsOption);

	var api = GetApiClient();
	if (api == null) return 1;

	if (string.IsNullOrWhiteSpace(query))
	{
		WriteJson(new { error = "Missing --query for search action." });
		return 1;
	}

	try
	{
		var res = await api.Search.Messages(query, count: maxResults);
		var userCache = new Dictionary<string, (string Id, string? Name)?>();

		// Collect user IDs to resolve
		var userIds = res.Messages.Matches
			.Take(maxResults)
			.Select(m => m.User ?? m.Username)
			.Where(u => !string.IsNullOrEmpty(u) && (u!.StartsWith("U") || u.StartsWith("W")))
			.Distinct()
			.ToList();

		await Task.WhenAll(userIds.Select(id => ResolveUserName(api, userCache, id)));

		var results = res.Messages.Matches.Take(maxResults).Select((m, i) =>
		{
			var rawUser = m.User ?? m.Username;
			string? userId = null;
			string? userName = null;

			if (!string.IsNullOrEmpty(rawUser))
			{
				if (userCache.TryGetValue(rawUser, out var c) && c.HasValue)
				{
					userId = c.Value.Id;
					userName = c.Value.Name;
				}
				else if (!rawUser.StartsWith("U") && !rawUser.StartsWith("W"))
				{
					userName = rawUser;
				}
			}

			return new
			{
				position = i + 1,
				text = m.Text ?? "",
				channel = m.Channel?.Name ?? m.Channel?.Id,
				ts = m.Ts,
				permalink = m.Permalink,
				user_id = userId,
				user_name = userName,
			};
		}).ToList();

		WriteJson(results);
		return 0;
	}
	catch (Exception ex)
	{
		WriteJson(new { error = $"Slack API error: {ex.Message}" });
		return 1;
	}
});

threadCommand.SetAction(async (parseResult, cancellationToken) =>
{
	var channel = parseResult.GetValue(channelOption);
	var threadTs = parseResult.GetValue(threadTsOption);
	var permalink = parseResult.GetValue(permalinkOption);
	var maxResults = parseResult.GetValue(maxResultsOption);

	var api = GetApiClient();
	if (api == null) return 1;

	// Parse permalink if provided
	if (!string.IsNullOrEmpty(permalink))
	{
		var match = Regex.Match(permalink, @"/archives/([A-Z0-9]+)/p(\d+)", RegexOptions.IgnoreCase);
		if (match.Success)
		{
			channel ??= match.Groups[1].Value;
			if (string.IsNullOrEmpty(threadTs))
			{
				var raw = match.Groups[2].Value;
				threadTs = raw.Length > 6
					? raw[..^6] + "." + raw[^6..]
					: "0." + raw.PadLeft(6, '0');
			}
		}
	}

	if (string.IsNullOrEmpty(channel))
	{
		WriteJson(new { error = "Missing --channel for thread action." });
		return 1;
	}
	if (string.IsNullOrEmpty(threadTs))
	{
		WriteJson(new { error = "Missing --thread-ts for thread action." });
		return 1;
	}

	var limit = Math.Min(maxResults, 1000);

	try
	{
		var res = await api.Conversations.Replies(channel, threadTs, limit: limit);
		var userCache = new Dictionary<string, (string Id, string? Name)?>();

		// Collect user IDs to resolve
		var userIds = res.Messages
			.Select(m => m.User)
			.Where(u => !string.IsNullOrEmpty(u) && (u!.StartsWith("U") || u.StartsWith("W")))
			.Distinct()
			.ToList();

		await Task.WhenAll(userIds.Select(id => ResolveUserName(api, userCache, id)));

		var results = res.Messages.Take(limit).Select((m, i) =>
		{
			var rawUser = m.User;
			string? userId = null;
			string? userName = null;

			if (!string.IsNullOrEmpty(rawUser) && userCache.TryGetValue(rawUser, out var c) && c.HasValue)
			{
				userId = c.Value.Id;
				userName = c.Value.Name;
			}

			return new
			{
				index = i + 1,
				user_id = userId,
				user_name = userName,
				text = m.Text ?? "",
				ts = m.Ts,
				thread_ts = m.ThreadTs,
			};
		}).ToList();

		WriteJson(results);
		return 0;
	}
	catch (Exception ex)
	{
		WriteJson(new { error = $"Slack API error: {ex.Message}" });
		return 1;
	}
});

return await rootCommand.Parse(args).InvokeAsync();

ISlackApiClient? GetApiClient()
{
	var token = Environment.GetEnvironmentVariable("SLACK_API_TOKEN");
	if (string.IsNullOrEmpty(token))
	{
		WriteJson(new { error = "SLACK_API_TOKEN not set. Export a token as the SLACK_API_TOKEN environment variable." });
		return null;
	}

	return new SlackServiceBuilder()
		.UseApiToken(token)
		.GetApiClient();
}

async Task ResolveUserName(ISlackApiClient api, Dictionary<string, (string Id, string? Name)?> cache, string? userId)
{
	if (string.IsNullOrEmpty(userId)) return;
	if (!userId.StartsWith("U") && !userId.StartsWith("W")) return;
	if (cache.ContainsKey(userId)) return;

	try
	{
		var info = await api.Users.Info(userId);
		var name = info.Profile?.DisplayName
			?? info.Profile?.RealName
			?? info.Name;
		cache[userId] = (userId, name);
	}
	catch
	{
		cache[userId] = null;
	}
}

void WriteJson(object obj) =>
	Console.WriteLine(JsonSerializer.Serialize(obj, obj.GetType(), jsonOptions));
