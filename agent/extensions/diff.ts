import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const commandName = "diff";

function getStringPath(input: unknown) {
	if (!input || typeof input !== "object" || !("path" in input)) return undefined;
	return typeof input.path === "string" ? input.path : undefined;
}

function toAbsolute(cwd: string, filePath: string) {
	return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);
}

function toRelative(cwd: string, filePath: string) {
	const relative = path.relative(cwd, filePath);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

function parseGitStatus(output: string, cwd: string) {
	const files = new Set<string>();

	for (const line of output.split("\n")) {
		if (line.length < 4) continue;

		// `git status --porcelain` format is two status columns, a space, then path.
		// Rename/copy entries look like `old -> new`; the destination is what we want to open.
		const rawPath = line.slice(3).trim();
		if (!rawPath) continue;

		const targetPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
		if (!targetPath) continue;

		files.add(toAbsolute(cwd, targetPath.replace(/^"|"$/g, "")));
	}

	return files;
}

async function getGitChangedFiles(pi: ExtensionAPI, cwd: string) {
	const result = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all"], {
		cwd,
		timeout: 5000,
	});

	if (result.code !== 0) return new Set<string>();
	return parseGitStatus(result.stdout, cwd);
}

function difference(current: Set<string>, baseline: Set<string>) {
	return new Set([...current].filter((file) => !baseline.has(file)));
}

async function getFileDiff(pi: ExtensionAPI, cwd: string, file: string) {
	const relative = toRelative(cwd, file);
	const result = await pi.exec("git", ["diff", "--", relative], { cwd, timeout: 5000 });
	if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();

	const staged = await pi.exec("git", ["diff", "--cached", "--", relative], { cwd, timeout: 5000 });
	if (staged.code === 0 && staged.stdout.trim()) return staged.stdout.trim();

	const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard", "--", relative], { cwd, timeout: 5000 });
	if (untracked.code === 0 && untracked.stdout.trim()) {
		const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
		const untrackedDiff = await pi.exec("git", ["diff", "--no-index", "--", nullFile, relative], { cwd, timeout: 5000 });
		return untrackedDiff.stdout.trim() || untrackedDiff.stderr.trim();
	}

	return `No git diff available for ${relative}. The file may have been touched without content changes.`;
}

export default function (pi: ExtensionAPI) {
	let gitBaseline = new Set<string>();
	let changedFiles = new Set<string>();
	let toolTouchedFiles = new Set<string>();

	pi.on("agent_start", async (_event, ctx) => {
		toolTouchedFiles = new Set();
		changedFiles = new Set();
		gitBaseline = await getGitChangedFiles(pi, ctx.cwd);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;

		const filePath = getStringPath(event.input);
		if (!filePath) return;

		toolTouchedFiles.add(toAbsolute(ctx.cwd, filePath));
	});

	pi.on("agent_end", async (_event, ctx) => {
		const gitChanged = await getGitChangedFiles(pi, ctx.cwd);
		changedFiles = new Set([...difference(gitChanged, gitBaseline), ...toolTouchedFiles]);

		if (changedFiles.size > 0) {
			ctx.ui.notify(`${changedFiles.size} changed file(s). Run /${commandName} to show a diff in Pi.`, "info");
		}
	});

	pi.registerCommand(commandName, {
		description: "Show files changed by the last agent run and print a git diff in Pi",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const arg = args.trim();
			if (arg === "clear") {
				changedFiles = new Set();
				toolTouchedFiles = new Set();
				gitBaseline = await getGitChangedFiles(pi, ctx.cwd);
				ctx.ui.notify("Cleared changed file list", "info");
				return;
			}

			const files = [...changedFiles].sort((a, b) => toRelative(ctx.cwd, a).localeCompare(toRelative(ctx.cwd, b)));
			if (files.length === 0) {
				ctx.ui.notify("No changed files tracked from the last agent run", "info");
				return;
			}

			if (arg === "list") {
				ctx.ui.notify(`Changed files:\n${files.map((file) => `- ${toRelative(ctx.cwd, file)}`).join("\n")}`, "info");
				return;
			}

			if (arg) {
				ctx.ui.notify(
					`Unknown /${commandName} argument: ${arg}. Try /${commandName}, /${commandName} list, or /${commandName} clear.`,
					"warning",
				);
				return;
			}

			const labels = files.map((file) => toRelative(ctx.cwd, file));
			const selected = await ctx.ui.select("Show changed file diff", labels);
			if (!selected) return;

			const selectedIndex = labels.indexOf(selected);
			const file = files[selectedIndex];
			if (!file) return;

			const diff = await getFileDiff(pi, ctx.cwd, file);
			ctx.ui.notify(`Diff for ${selected}:\n\n${diff}`, "info");
		},
	});
}
