#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_SESSIONS_DIR = "~/.pi/agent/sessions";
const GREP_FAMILY = /^(grep|egrep|fgrep|rg|ag|ack|pt)$/;
const BLOCK_MARKER = "bypasses the tgrep index";
const NO_RESULT = /^No matches found\.?\s*$/;
const SHELL_TOOLS = new Set(["bash", "ctx_execute", "ctx_execute_file", "ctx_batch_execute"]);
const DURATION = /^(\d+)([dhw])$/;

function expandHome(value) {
	if (!value) return value;
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function parseArgs(argv) {
	const args = { sessionsDir: DEFAULT_SESSIONS_DIR, cwd: undefined, since: undefined, top: 8, followWindow: 3, json: false, help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--sessions-dir") { args.sessionsDir = next; i += 1; }
		else if (arg === "--cwd") { args.cwd = next; i += 1; }
		else if (arg === "--since") { args.since = next; i += 1; }
		else if (arg === "--top") { args.top = Number(next); i += 1; }
		else if (arg === "--follow-window") { args.followWindow = Number(next); i += 1; }
		else if (arg === "--json") { args.json = true; }
		else if (arg === "--help" || arg === "-h") { args.help = true; }
		else throw new Error(`Unknown argument: ${arg}`);
	}
	args.sessionsDir = expandHome(args.sessionsDir);
	if (args.since !== undefined && !DURATION.test(args.since)) throw new Error(`Invalid --since duration: ${args.since} (use e.g. 30d, 24h, 2w)`);
	return args;
}

function printHelp() {
	console.log(`Analyze pi session logs for evidence of how pi-tgrep performs in practice.

Reads JSONL session transcripts, counts grep tool usage (indexed vs fallback vs
builtin vs unknown attribution), shell grep-family usage (tgrep, plain grep/rg, blocked by
the tool_call policy), zero-result and error rates, latency, and whether
searches convert into reads or degenerate into shell fallbacks.

Usage:
  node scripts/analyze-pi-sessions.mjs [options]

Options:
  --sessions-dir <dir>   Session root. Default: ${DEFAULT_SESSIONS_DIR}
  --cwd <substring>      Only include sessions whose cwd contains this text
  --since <duration>     Only sessions started within this window (e.g. 30d, 24h, 2w)
  --top <n>              Examples per top-list. Default: 8
  --follow-window <n>    Later tool calls scanned for follow-up behaviour. Default: 3
  --json                 Machine-readable JSON output
  --help, -h             Show this help

Examples:
  node scripts/analyze-pi-sessions.mjs
  node scripts/analyze-pi-sessions.mjs --cwd Projects/NServiceBus --since 30d
  node scripts/analyze-pi-sessions.mjs --json | jq '.grep.indexedShare'
`);
}

async function listJsonlFiles(rootDir) {
	const files = [];
	const stack = [rootDir];
	while (stack.length) {
		const current = stack.pop();
		let entries;
		try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
		}
	}
	files.sort();
	return files;
}

function toMs(value) {
	if (typeof value === "number") return value;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function eventTsOf(event, message) {
	return toMs(event.timestamp) ?? toMs(event.ts) ?? toMs(message.timestamp);
}

function stringsDeep(value, out = []) {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) stringsDeep(item, out);
	else if (value && typeof value === "object") for (const item of Object.values(value)) stringsDeep(item, out);
	return out;
}

function shellSegments(command) {
	return String(command).split(/(?:\|\||&&|[;|])/).map((segment) => segment.trim()).filter(Boolean);
}

function primaryBinary(segment) {
	const tokens = segment.split(/\s+/);
	let index = 0;
	if (tokens[0] === "cd") {
		if (tokens[1] === undefined) return "";
		index = tokens[1].startsWith("-") ? 1 : 2;
	}
	while (index < tokens.length && ["sudo", "env", "command", "exec", "nice", "nohup", "time"].includes(tokens[index])) index += 1;
	return tokens[index] ?? "";
}

function classifyCommandText(text) {
	const found = { shellSearch: false, shellTgrep: false, binaries: new Set() };
	for (const segment of shellSegments(text)) {
		const bin = primaryBinary(segment);
		if (!bin) continue;
		found.binaries.add(bin);
		if (GREP_FAMILY.test(bin)) found.shellSearch = true;
		if (bin === "tgrep") found.shellTgrep = true;
	}
	return found;
}

function attribution(details) {
	if (!details || typeof details !== "object") return "unknown";
	if (details.engine === "tgrep") return "indexed";
	if (details.engine === "rg-fallback") return "fallback";
	if ("matchLimitReached" in details || "linesTruncated" in details || "truncation" in details) return "builtin";
	return "unknown";
}

function snippet(value, max = 110) {
	const collapsed = String(value ?? "").replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function commandText(args) {
	if (!args || typeof args !== "object") return "";
	if (typeof args.command === "string") return args.command;
	if (typeof args.code === "string") return args.code;
	return stringsDeep(args).join(" ");
}

function bump(counter, key, amount = 1) {
	if (!key) return;
	counter.set(key, (counter.get(key) ?? 0) + amount);
}

function topEntries(counter, limit) {
	return [...counter.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit).map(([key, count]) => ({ key, count }));
}

function quantile(values, q) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

function pct(part, total) {
	return total ? part / total : null;
}

function createTotals() {
	return {
		files: 0, matchedFiles: 0, unreadableFiles: 0, orphanResults: 0,
		grepCalls: 0, grepByAttribution: { indexed: 0, fallback: 0, builtin: 0, unknown: 0 },
		grepNoResult: 0, grepErrors: 0, grepNoResultByAttribution: { indexed: 0, fallback: 0, builtin: 0, unknown: 0 },
		grepLatency: { indexed: [], fallback: [], builtin: [], unknown: [] },
		grepPatterns: new Map(), grepNoResultPatterns: new Map(),
		grepLeadingToRead: 0, grepActionable: 0,
		failedGrepLeadingToShell: 0, failedGrepCount: 0,
		shellCalls: 0, shellSearchCalls: 0, shellTgrepCalls: 0, shellSearchExecuted: 0,
		shellBlocked: 0, blockedLeadingToGrepTool: 0,
		shellSearchCommands: new Map(), blockedCommands: new Map(), tgrepShellCommands: new Map(),
	};
}

async function analyzeFile(filePath, totals, filters, options) {
	const handle = fs.createReadStream(filePath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: handle, crlfDelay: Infinity });
	const calls = [];
	const callsById = new Map();
	let sessionCwd = null;
	let sessionStart = undefined;

	try {
		for await (const line of rl) {
			if (!(line.includes('"toolCall"') || line.includes('"toolResult"') || line.includes('"session"'))) continue;
			let event;
			try { event = JSON.parse(line); } catch { continue; }

			// subagent transcripts use recordType + top-level cwd/timestamps instead of the session envelope
			const recordType = event.type ?? event.recordType;
			if (recordType === "session") {
				sessionCwd = typeof event.cwd === "string" ? event.cwd : sessionCwd;
				sessionStart = eventTsOf(event, event) ?? sessionStart;
				continue;
			}
			if (recordType !== "message") continue;
			const message = event.message;
			if (!message || typeof message !== "object") continue;
			if (sessionCwd === null && typeof event.cwd === "string") sessionCwd = event.cwd;
			const eventTs = eventTsOf(event, message);
			if (sessionStart === undefined && eventTs !== undefined) sessionStart = eventTs;

			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content) {
					if (!block || block.type !== "toolCall") continue;
					const call = {
						id: String(block.id ?? ""),
						name: String(block.name ?? "unknown"),
						args: block.arguments ?? {},
						ts: eventTs,
						result: null,
					};
					calls.push(call);
					if (call.id && !callsById.has(call.id)) callsById.set(call.id, call);
				}
				continue;
			}

			if (message.role === "toolResult") {
				const text = Array.isArray(message.content)
					? message.content.map((block) => (block && typeof block === "object" && block.type === "text" ? block.text : "")).join("\n")
					: "";
				const record = {
					ts: eventTs,
					isError: Boolean(message.isError),
					text,
					details: message.details ?? null,
				};
				const callId = String(message.toolCallId ?? "");
				const call = callId ? callsById.get(callId) : calls.find((entry) => entry.id === "");
				if (call) call.result = record;
				else totals.orphanResults += 1;
			}
		}
	} finally {
		rl.close();
		handle.close();
	}

	totals.files += 1;
	if (filters.cwd && !(sessionCwd ?? "").includes(filters.cwd)) return;
	if (filters.sinceMs !== undefined && (sessionStart === undefined || sessionStart < filters.sinceMs)) return;
	totals.matchedFiles += 1;

	for (const call of calls) {
		const result = call.result;
		const index = calls.indexOf(call);
		const follow = calls.slice(index + 1, index + 1 + options.followWindow);

		if (call.name === "grep") {
			totals.grepCalls += 1;
			const attr = attribution(result?.details);
			totals.grepByAttribution[attr] += 1;
			const noResult = Boolean(result && !result.isError && NO_RESULT.test(result.text.trim()));
			const isError = Boolean(result?.isError);
			if (noResult) {
				totals.grepNoResult += 1;
				totals.grepNoResultByAttribution[attr] += 1;
				bump(totals.grepNoResultPatterns, snippet(call.args.pattern));
			}
			if (isError) totals.grepErrors += 1;
			if (result && result.ts !== undefined && call.ts !== undefined) {
				const duration = Math.max(0, result.ts - call.ts);
				totals.grepLatency[attr].push(duration);
			}
			if (typeof call.args.pattern === "string" && call.args.pattern) bump(totals.grepPatterns, snippet(call.args.pattern));
			if (result && !isError && !noResult) {
				totals.grepActionable += 1;
				if (follow.some((next) => next.name === "read")) totals.grepLeadingToRead += 1;
			}
			if ((noResult || isError) && follow.some((next) => {
				if (!SHELL_TOOLS.has(next.name)) return false;
				return classifyCommandText(commandText(next.args)).shellSearch;
			})) {
				totals.failedGrepLeadingToShell += 1;
			}
			if (noResult || isError) totals.failedGrepCount += 1;
			continue;
		}

		if (SHELL_TOOLS.has(call.name)) {
			totals.shellCalls += 1;
			const text = commandText(call.args);
			const classified = classifyCommandText(text);
			if (classified.shellSearch) {
				totals.shellSearchCalls += 1;
				bump(totals.shellSearchCommands, snippet(text));
			}
			if (classified.shellTgrep) {
				totals.shellTgrepCalls += 1;
				bump(totals.tgrepShellCommands, snippet(text));
			}
			const blocked = Boolean(result?.isError && result.text.includes(BLOCK_MARKER));
			if (classified.shellSearch && blocked) {
				totals.shellBlocked += 1;
				bump(totals.blockedCommands, snippet(text));
				if (follow.some((next) => next.name === "grep")) totals.blockedLeadingToGrepTool += 1;
			} else if (classified.shellSearch && result) {
				totals.shellSearchExecuted += 1;
			}
		}
	}
}

function latencyBucket(values) {
	return { samples: values.length, p50Ms: quantile(values, 0.5), p95Ms: quantile(values, 0.95) };
}

function buildOutput(totals, args, options) {
	const grepLatency = Object.fromEntries(Object.entries(totals.grepLatency).map(([key, values]) => [key, latencyBucket(values)]));
	const output = {
		selection: {
			sessionsDir: expandHome(args.sessionsDir),
			cwdFilter: args.cwd ?? null,
			since: args.since ?? null,
			filesScanned: totals.files,
			filesMatched: totals.matchedFiles,
			unreadableFiles: totals.unreadableFiles,
			followWindow: options.followWindow,
			orphanResults: totals.orphanResults,
		},
		grep: {
			calls: totals.grepCalls,
			attribution: totals.grepByAttribution,
			indexedShare: pct(totals.grepByAttribution.indexed, totals.grepCalls),
			noResult: totals.grepNoResult,
			noResultRate: pct(totals.grepNoResult, totals.grepCalls),
			noResultByAttribution: totals.grepNoResultByAttribution,
			errors: totals.grepErrors,
			errorRate: pct(totals.grepErrors, totals.grepCalls),
			latencyMs: grepLatency,
			actionable: totals.grepActionable,
			actionableLeadingToRead: totals.grepLeadingToRead,
			searchToReadRate: pct(totals.grepLeadingToRead, totals.grepActionable),
			topPatterns: topEntries(totals.grepPatterns, args.top),
			topNoResultPatterns: topEntries(totals.grepNoResultPatterns, args.top),
		},
		shell: {
			shellToolCalls: totals.shellCalls,
			grepFamilyCommands: totals.shellSearchCalls,
			grepFamilyExecuted: totals.shellSearchExecuted,
			grepFamilyBlocked: totals.shellBlocked,
			blockRate: pct(totals.shellBlocked, totals.shellSearchCalls),
			tgrepCommands: totals.shellTgrepCalls,
			blockedLeadingToGrepTool: totals.blockedLeadingToGrepTool,
			failedGrepFollowedByShellSearch: totals.failedGrepLeadingToShell,
			failedGrepCount: totals.failedGrepCount,
			shellFallbackAfterFailedGrep: pct(totals.failedGrepLeadingToShell, totals.failedGrepCount),
			topSearchCommands: topEntries(totals.shellSearchCommands, args.top),
			topBlockedCommands: topEntries(totals.blockedCommands, args.top),
			topTgrepCommands: topEntries(totals.tgrepShellCommands, args.top),
		},
		caveats: [
			"details.engine is only persisted for some grep results; 'indexed' attribution is a lower bound and most calls land in 'unknown'.",
			"'tgrep' shell commands mix policy-translated greps with model-typed tgrep invocations; the log does not distinguish them.",
			"Shell classification splits commands naively and reads each segment's primary binary, mirroring the extension's approximation.",
			"Latency uses session event timestamps (call event -> toolResult event) and includes model-side queueing, not just search time.",
		],
	};
	return output;
}

function fmtPct(value) {
	return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function fmtMs(value) {
	return value === null || value === undefined ? "n/a" : `${value}ms`;
}

function renderTop(title, items) {
	const lines = [title];
	if (!items.length) return [...lines, "  - none"].join("\n");
	for (const item of items) lines.push(`  - ${item.count}x  ${item.key}`);
	return lines.join("\n");
}

function renderText(output) {
	const { selection, grep, shell, caveats } = output;
	return [
		"=".repeat(88),
		"pi sessions x pi-tgrep analysis",
		"=".repeat(88),
		`Sessions dir: ${selection.sessionsDir}`,
		`CWD filter: ${selection.cwdFilter ?? "(none)"}  Since: ${selection.since ?? "(all)"}`,
		`Files scanned: ${selection.filesScanned}  matched: ${selection.filesMatched}  unreadable: ${selection.unreadableFiles}  orphan results: ${selection.orphanResults}`,
		"",
		"Grep tool",
		`  Calls: ${grep.calls}  (indexed: ${grep.attribution.indexed}, fallback: ${grep.attribution.fallback}, builtin-fingerprint: ${grep.attribution.builtin}, unknown: ${grep.attribution.unknown})`,
		`  Indexed share: ${fmtPct(grep.indexedShare)}  (lower bound - details are often not persisted)`,
		`  No results: ${grep.noResult} (${fmtPct(grep.noResultRate)})  Errors: ${grep.errors} (${fmtPct(grep.errorRate)})`,
		`  Search->read: ${grep.actionableLeadingToRead}/${grep.actionable} (${fmtPct(grep.searchToReadRate)})`,
		`  Latency p50/p95: indexed ${fmtMs(grep.latencyMs.indexed.p50Ms)}/${fmtMs(grep.latencyMs.indexed.p95Ms)}  fallback ${fmtMs(grep.latencyMs.fallback.p50Ms)}/${fmtMs(grep.latencyMs.fallback.p95Ms)}  builtin ${fmtMs(grep.latencyMs.builtin.p50Ms)}/${fmtMs(grep.latencyMs.builtin.p95Ms)}  unknown ${fmtMs(grep.latencyMs.unknown.p50Ms)}/${fmtMs(grep.latencyMs.unknown.p95Ms)}`,
		"",
		"Shell grep-family",
		`  Shell tool calls: ${shell.shellToolCalls}  grep-family segments: ${shell.grepFamilyCommands}`,
		`  Executed: ${shell.grepFamilyExecuted}  Blocked: ${shell.grepFamilyBlocked} (block rate ${fmtPct(shell.blockRate)})`,
		`  tgrep in shell: ${shell.tgrepCommands}  Blocked -> grep tool within window: ${shell.blockedLeadingToGrepTool}`,
		`  Failed grep -> shell search fallback: ${shell.failedGrepFollowedByShellSearch}/${shell.failedGrepCount} (${fmtPct(shell.shellFallbackAfterFailedGrep)})`,
		"",
		renderTop("Top no-result grep patterns", grep.topNoResultPatterns),
		"",
		renderTop("Top blocked shell commands", shell.topBlockedCommands),
		"",
		renderTop("Top shell search commands", shell.topSearchCommands),
		"",
		renderTop("Top tgrep shell commands", shell.topTgrepCommands),
		"",
		"Caveats",
		...caveats.map((line) => `  - ${line}`),
	].join("\n");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}
	const options = { followWindow: Number.isFinite(args.followWindow) && args.followWindow > 0 ? args.followWindow : 3 };
	const sinceMs = args.since ? Date.now() - Number(args.since.slice(0, -1)) * { d: 86_400_000, h: 3_600_000, w: 604_800_000 }[args.since.slice(-1)] : undefined;
	const filters = { cwd: args.cwd, sinceMs };
	const totals = createTotals();
	const files = await listJsonlFiles(args.sessionsDir);
	if (!files.length) {
		console.error(`No .jsonl session files found under ${expandHome(args.sessionsDir)}`);
		process.exitCode = 1;
		return;
	}
	for (const file of files) {
		try {
			await analyzeFile(file, totals, filters, options);
		} catch {
			totals.unreadableFiles += 1;
		}
	}
	const output = buildOutput(totals, args, options);
	if (args.json) console.log(JSON.stringify(output, null, 2));
	else console.log(renderText(output));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
