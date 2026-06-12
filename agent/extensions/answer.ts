/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Custom interactive TUI for answering questions.
 *
 * Demonstrates the "prompt generator" pattern with custom TUI:
 * 1. /answer command gets the last assistant message
 * 2. Shows a spinner while extracting questions as structured JSON
 * 3. Presents an interactive TUI to navigate and answer questions
 * 4. Submits the compiled answers when done
 */

import { createHash } from "node:crypto";
import { complete, type Model, type Api, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// Structured output format for question extraction
interface ExtractedQuestion {
	question: string;
	context?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

interface AnswerDraftState {
	draftId: string;
	status: "active" | "submitted";
	sourceHash: string;
	questions: ExtractedQuestion[];
	answers: string[];
	currentIndex: number;
	updatedAt: number;
}

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented."
    },
    {
      "question": "Should we use TypeScript or JavaScript?"
    }
  ]
}`;

const GEMINI_MODEL_ID = "gemini-3-flash-preview";

/**
 * Prefer Gemini flash for extraction when available, otherwise fallback to the current model.
 */
async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
	const geminiModel = modelRegistry.find("ollama", GEMINI_MODEL_ID);
	if (geminiModel) {
		return geminiModel;
	}

	return currentModel;
}

/**
 * Parse the JSON response from the LLM
 */
function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		// Try to find JSON in the response (it might be wrapped in markdown code blocks)
		let jsonStr = text;

		// Remove markdown code block if present
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}

		const parsed = JSON.parse(jsonStr);
		if (parsed && Array.isArray(parsed.questions)) {
			return parsed as ExtractionResult;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Interactive Q&A component for answering extracted questions
 */
class QnAComponent implements Component {
	private draftId: string;
	private sourceHash: string;
	private questions: ExtractedQuestion[];
	private answers: string[];
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private onPersist: (state: AnswerDraftState) => void;
	private showingConfirmation: boolean = false;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Colors - using proper reset sequences
	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(
		draftId: string,
		sourceHash: string,
		questions: ExtractedQuestion[],
		tui: TUI,
		onDone: (result: string | null) => void,
		onPersist: (state: AnswerDraftState) => void,
		initialAnswers?: string[],
		initialIndex: number = 0,
	) {
		this.draftId = draftId;
		this.sourceHash = sourceHash;
		this.questions = questions;
		this.answers = questions.map((_, i) => initialAnswers?.[i] || "");
		this.currentIndex = Math.max(0, Math.min(initialIndex, questions.length - 1));
		this.tui = tui;
		this.onDone = onDone;
		this.onPersist = onPersist;

		// Create a minimal theme for the editor
		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedBg: (s: string) => `\x1b[44m${s}\x1b[0m`,
				matchHighlight: this.cyan,
				itemSecondary: this.gray,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		this.editor.setText(this.answers[this.currentIndex] || "");
		// Disable the editor's built-in submit (which clears the editor)
		// We'll handle Enter ourselves to preserve the text
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.saveCurrentAnswer();
			this.persist("active");
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private allQuestionsAnswered(): boolean {
		this.saveCurrentAnswer();
		return this.answers.every((a) => (a?.trim() || "").length > 0);
	}

	private saveCurrentAnswer(): void {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || "");
		this.persist("active");
		this.invalidate();
	}

	private persist(status: AnswerDraftState["status"]): void {
		this.onPersist({
			draftId: this.draftId,
			status,
			sourceHash: this.sourceHash,
			questions: this.questions,
			answers: [...this.answers],
			currentIndex: this.currentIndex,
			updatedAt: Date.now(),
		});
	}

	private submit(): void {
		this.saveCurrentAnswer();
		this.persist("submitted");

		// Build the response text
		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const a = this.answers[i]?.trim() || "(no answer)";
			parts.push(`Q: ${q.question}`);
			if (q.context) {
				parts.push(`> ${q.context}`);
			}
			parts.push(`A: ${a}`);
			parts.push("");
		}

		this.onDone(parts.join("\n").trim());
	}

	private cancel(): void {
		this.saveCurrentAnswer();
		this.persist("active");
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		// Handle confirmation dialog
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		// Global navigation and commands
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		// Tab / Shift+Tab for navigation
		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}

		// Arrow up/down for question navigation when editor is empty
		// (Editor handles its own cursor navigation when there's content)
		if (matchesKey(data, Key.up) && this.editor.getText() === "") {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
				return;
			}
		}
		if (matchesKey(data, Key.down) && this.editor.getText() === "") {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
				return;
			}
		}

		// Handle Enter ourselves (editor's submit is disabled)
		// Plain Enter moves to next question or shows confirmation on last question
		// Shift+Enter adds a newline (handled by editor)
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				// On last question - show confirmation
				this.showingConfirmation = true;
				this.persist("active");
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Pass to editor
		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120); // Allow wider box
		const contentWidth = boxWidth - 4; // 2 chars padding on each side

		// Helper to create horizontal lines (dim the whole thing at once)
		const horizontalLine = (count: number) => "─".repeat(count);

		// Helper to create a box line
		const boxLine = (content: string, leftPad: number = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};

		const emptyBoxLine = (): string => {
			return this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		};

		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		// Title
		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.cyan("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		// Progress indicator
		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || "").length > 0;
			const current = i === this.currentIndex;
			if (current) {
				progressParts.push(this.cyan("●"));
			} else if (answered) {
				progressParts.push(this.green("●"));
			} else {
				progressParts.push(this.dim("○"));
			}
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		// Current question
		const q = this.questions[this.currentIndex];
		const questionText = `${this.bold("Q:")} ${q.question}`;
		const wrappedQuestion = wrapTextWithAnsi(questionText, contentWidth);
		for (const line of wrappedQuestion) {
			lines.push(padToWidth(boxLine(line)));
		}

		// Context if present
		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			const contextText = this.gray(`> ${q.context}`);
			const wrappedContext = wrapTextWithAnsi(contextText, contentWidth - 2);
			for (const line of wrappedContext) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Render the editor component (multi-line input) with padding
		// Skip the first and last lines (editor's own border lines)
		const answerPrefix = this.bold("A: ");
		const editorWidth = contentWidth - 4 - 3; // Extra padding + space for "A: "
		const editorLines = this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			if (i === 1) {
				// First content line gets the "A: " prefix
				lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
			} else {
				// Subsequent lines get padding to align with the first line
				lines.push(padToWidth(boxLine("   " + editorLines[i])));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Confirmation dialog or footer with controls
		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

const ANSWER_STATE_TYPE = "answer-state";

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function createDraftId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getLastAssistantText(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message") {
			const msg = entry.message;
			if ("role" in msg && msg.role === "assistant") {
				if (msg.stopReason !== "stop") {
					return undefined;
				}
				const textParts = msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text);
				if (textParts.length > 0) {
					return textParts.join("\n");
				}
			}
		}
	}

	return undefined;
}

function getLatestDraftState(ctx: ExtensionContext): AnswerDraftState | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === ANSWER_STATE_TYPE) {
			return entry.data as AnswerDraftState;
		}
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	const persistDraft = (state: AnswerDraftState) => {
		pi.appendEntry(ANSWER_STATE_TYPE, state);
	};

	const answerHandler = async (args: string | undefined, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("answer requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const trimmedArgs = args?.trim();
			if (trimmedArgs && trimmedArgs !== "-c") {
				ctx.ui.notify("Usage: /answer [-c]", "error");
				return;
			}
			const continueLast = trimmedArgs === "-c";
			const lastAssistantText = getLastAssistantText(ctx);
			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}
			const sourceHash = hashText(lastAssistantText);

			let extractionResult: ExtractionResult | null;
			let draftId: string;
			let initialAnswers: string[] | undefined;
			let initialIndex = 0;

			if (continueLast) {
				const draft = getLatestDraftState(ctx);
				if (!draft || draft.status !== "active") {
					ctx.ui.notify("No unfinished /answer session", "info");
					return;
				}
				if (draft.sourceHash !== sourceHash) {
					ctx.ui.notify("Saved /answer draft does not match the current last assistant message", "error");
					return;
				}
				extractionResult = { questions: draft.questions };
				draftId = draft.draftId;
				initialAnswers = draft.answers;
				initialIndex = draft.currentIndex;
			} else {
				draftId = createDraftId();
				extractionResult = null;
			}

			if (!extractionResult) {
				// Select the best model for extraction (prefer Gemini flash when available)
				const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);

				// Run extraction with loader UI
				extractionResult = await ctx.ui.custom<ExtractionResult | null>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
					loader.onAbort = () => done(null);

					const doExtract = async () => {
						const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
						if (!auth.ok) {
							throw new Error(auth.error);
						}
						const userMessage: UserMessage = {
							role: "user",
							content: [{ type: "text", text: lastAssistantText }],
							timestamp: Date.now(),
						};

						const response = await complete(
							extractionModel,
							{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
							{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
						);

						if (response.stopReason === "aborted") {
							return null;
						}

						const responseText = response.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n");

						return parseExtractionResult(responseText);
					};

					doExtract()
						.then(done)
						.catch(() => done(null));

					return loader;
				});
			}

			if (extractionResult === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			if (extractionResult.questions.length === 0) {
				ctx.ui.notify("No questions found in the last message", "info");
				return;
			}

			if (!continueLast) {
				persistDraft({
					draftId,
					status: "active",
					sourceHash,
					questions: extractionResult.questions,
					answers: extractionResult.questions.map(() => ""),
					currentIndex: 0,
					updatedAt: Date.now(),
				});
			}

			// Show the Q&A component
			const answersResult = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
				return new QnAComponent(
					draftId,
					sourceHash,
					extractionResult.questions,
					tui,
					done,
					persistDraft,
					initialAnswers,
					initialIndex,
				);
			});

			if (answersResult === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Send the answers directly as a message and trigger a turn
			pi.sendMessage(
				{
					customType: "answers",
					content: "I answered your questions in the following way:\n\n" + answersResult,
					display: true,
				},
				{ triggerTurn: true },
			);
	};

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A (-c to continue draft)",
		getArgumentCompletions: (prefix) => {
			const option = { value: "-c", label: "-c" };
			return !prefix || option.value.startsWith(prefix) ? [option] : null;
		},
		handler: (args, ctx) => answerHandler(args, ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: (ctx) => answerHandler(undefined, ctx),
	});
}
