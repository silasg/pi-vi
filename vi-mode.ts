/**
 * Vi Mode Extension
 *
 * Vim-style modal editing with starship-like prompt indicators.
 *
 * Features:
 * - Insert mode (default): ❯ (green)
 * - Normal mode: ❮ (yellow)
 * - Navigation: h, j, k, l, 0, $, w, b, e, W, B, E, gg, G
 * - Find motions: f/F/t/T{char}, ; (repeat), , (reverse repeat)
 * - Operators with counts: c3w, d2w, y2j, etc.
 * - Line-wise operators: dd, cc, yy, dj, dk, cj, ck, yj, yk
 * - Text objects: iw, aw, i"/a", i'/a', i`/a`, i(/a(, i[/a[, i{/a{, i</a<
 * - Editing: r{char}, s, S, x, X, o, O, D, C, p, P, Y, u (undo)
 * - Line-wise p/P: dd, yy, dj, Y, etc. paste as whole lines below/above (vim semantics)
 * - Dot repeat (.): replays last change
 * - Clipboard: yanks/deletes write-through to the OS clipboard by default;
 *   p/P read the internal register (reliable). `/vi clipboard on` opts into
 *   pasting from the OS clipboard.
 *
 * Usage: pi --extension ~/.pi/agent/extensions/vi-mode.ts
 */

import { copyToClipboard, CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Settings (cached - requires restart after changing)
let settingsManager: SettingsManager | undefined;

function getSettingsManager(cwd: string = process.cwd()): SettingsManager {
	settingsManager ??= SettingsManager.create(cwd);
	return settingsManager;
}

import { Editor, matchesKey, truncateToWidth, visibleWidth, type TUI, type EditorTheme } from "@earendil-works/pi-tui";

type Mode = "normal" | "insert";
type Operator = "c" | "d" | "y" | null;
type FindMotionType = "f" | "F" | "t" | "T";

function keyInput(key: string): string | undefined {
	let modifiers = 1;
	let name = key.toLowerCase();
	for (;;) {
		const prefix = /^(shift|alt|ctrl|super)\+/.exec(name);
		if (!prefix) break;
		modifiers += prefix[1] === "shift" ? 1 : prefix[1] === "alt" ? 2 : prefix[1] === "ctrl" ? 4 : 8;
		name = name.slice(prefix[0].length);
	}
	if (name === "clear") {
		return modifiers === 1 ? "\x1b[E" : modifiers === 2 ? "\x1b[e" : modifiers === 5 ? "\x1bOe" : undefined;
	}
	const finals: Readonly<Record<string, string>> = {
		up: "A", down: "B", right: "C", left: "D", home: "H", end: "F",
		f1: "P", f2: "Q", f3: "R", f4: "S",
	};
	const final = finals[name];
	if (final) {
		if (modifiers === 1 && /^f[1-4]$/.test(name)) return `\x1bO${final}`;
		return modifiers === 1 ? `\x1b[${final}` : `\x1b[1;${modifiers}${final}`;
	}
	const tildeCodes: Readonly<Record<string, number>> = {
		insert: 2, delete: 3, pageup: 5, pagedown: 6,
		f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24,
	};
	const tildeCode = tildeCodes[name];
	if (tildeCode !== undefined) return `\x1b[${tildeCode};${modifiers}~`;
	const codepoints: Readonly<Record<string, number>> = {
		escape: 27, esc: 27, enter: 13, return: 13, tab: 9, space: 32, backspace: 127,
	};
	const codepoint = name.length === 1 ? name.codePointAt(0) : codepoints[name];
	return codepoint === undefined ? undefined : `\x1b[${codepoint};${modifiers}u`;
}

type EditorAction = `tui.editor.${
	"cursorLeft" | "cursorRight" | "cursorUp" | "cursorDown" |
	"cursorLineStart" | "cursorLineEnd" | "cursorWordLeft" | "cursorWordRight" | "undo"
}`;

// Starship-style indicators
const INSERT_INDICATOR = "❯";
const NORMAL_INDICATOR = "❮";

// Reverse map for find motions: f<->F, t<->T
const FIND_REVERSE: Record<FindMotionType, FindMotionType> = { f: "F", F: "f", t: "T", T: "t" };

// Word motion functions keyed by motion character
const WORD_MOTION_FN: Record<string, (text: string, pos: number) => number> = {
	w: findNextWordStart, b: findPrevWordStart, e: findWordEnd,
	W: findNextWORDStart, B: findPrevWORDStart, E: findWORDEnd,
};

// Bracket pairs for text objects: char -> [open, close]
const BRACKET_PAIRS: Record<string, [string, string]> = {
	"(": ["(", ")"], ")": ["(", ")"],
	"[": ["[", "]"], "]": ["[", "]"],
	"{": ["{", "}"], "}": ["{", "}"],
	"<": ["<", ">"], ">": ["<", ">"],
};

// Clipboard utilities
import { execSync, spawnSync } from "node:child_process";

// Only the opt-in clipboard reader uses local command detection.
let clipboardPasteCmd: string[] | null | undefined;

function getClipboardPasteCmd(): string[] | null {
	if (clipboardPasteCmd !== undefined) return clipboardPasteCmd;
	clipboardPasteCmd = detectClipboardPasteCommand();
	return clipboardPasteCmd;
}

function detectClipboardPasteCommand(): string[] | null {
	const platform = process.platform;
	if (platform === "darwin") {
		return ["pbpaste"];
	} else if (platform === "linux") {
		try {
			execSync("which xclip", { stdio: "ignore" });
			return ["xclip", "-selection", "clipboard", "-o"];
		} catch {
			try {
				execSync("which xsel", { stdio: "ignore" });
				return ["xsel", "--clipboard", "--output"];
			} catch {
				return null;
			}
		}
	} else if (platform === "win32") {
		return ["powershell.exe", "-command", "Get-Clipboard"];
	}
	return null;
}

function pasteFromClipboard(): string | null {
	const cmd = getClipboardPasteCmd();
	if (!cmd) return null;
	try {
		const [bin, ...args] = cmd;
		const result = spawnSync(bin!, args, { stdio: ["ignore", "pipe", "ignore"] });
		if (result.status === 0) {
			const out = result.stdout.toString();
			// A working clipboard reader can legitimately return an empty string,
			// but on headless machines `xclip`/`xsel` exit 0 with empty output even
			// when there is no X display. Treat empty output as "no clipboard" so
			// getFromRegister() falls back to the internal register (dd/yy still work).
			if (out.length === 0) return null;
			return out;
		}
		return null;
	} catch {
		return null;
	}
}

// Internal register. Carries whether the yank/delete was line-wise (dd, yy, cc,
// dj, dk, Y, ...) so that p/P can reproduce vim's line-wise paste semantics.
interface Register {
	text: string;
	lineWise: boolean;
}
let internalRegister: Register = { text: "", lineWise: false };

// Clipboard sync policy.
// - writeThrough: async Pi clipboard writes are serialized and pending values
//   coalesce to the latest yank/delete. The internal register is immediate.
// - readFromClipboard: p/P read the OS clipboard first. OFF by default: the OS
//   clipboard is a shared, unreliable resource (headless xclip, WSL, SSH) and
//   letting it drive p breaks the vim contract that p pastes what you just
//   yanked. Opt in via `/vi clipboard on` for `"+p`-style behavior.
const CLIPBOARD_WRITE_THROUGH = true;
let clipboardReadEnabled = false;

// --- Word/WORD motion functions ---

function findNextWordStart(text: string, pos: number): number {
	while (pos < text.length && !/\s/.test(text[pos]!)) pos++;
	while (pos < text.length && /\s/.test(text[pos]!)) pos++;
	return pos;
}

function findPrevWordStart(text: string, pos: number): number {
	if (pos > 0) pos--;
	while (pos > 0 && /\s/.test(text[pos]!)) pos--;
	while (pos > 0 && !/\s/.test(text[pos - 1]!)) pos--;
	return pos;
}

function findWordEnd(text: string, pos: number): number {
	if (pos < text.length && !/\s/.test(text[pos]!)) {
		while (pos < text.length && !/\s/.test(text[pos]!)) pos++;
		return pos;
	}
	while (pos < text.length && /\s/.test(text[pos]!)) pos++;
	while (pos < text.length && !/\s/.test(text[pos]!)) pos++;
	return pos;
}

function findNextWORDStart(text: string, pos: number): number {
	while (pos < text.length && !/\s/.test(text[pos]!)) pos++;
	while (pos < text.length && /\s/.test(text[pos]!)) pos++;
	return pos;
}

function findPrevWORDStart(text: string, pos: number): number {
	if (pos > 0) pos--;
	while (pos > 0 && /\s/.test(text[pos]!)) pos--;
	while (pos > 0 && !/\s/.test(text[pos - 1]!)) pos--;
	return pos;
}

function findWORDEnd(text: string, pos: number): number {
	if (pos < text.length && !/\s/.test(text[pos]!)) {
		while (pos < text.length && !/\s/.test(text[pos]!)) pos++;
		return pos;
	}
	while (pos < text.length && /\s/.test(text[pos]!)) pos++;
	while (pos < text.length && !/\s/.test(text[pos]!)) pos++;
	return pos;
}

// --- Text object boundary functions ---

function getInnerWord(text: string, pos: number): { start: number; end: number } | null {
	if (pos >= text.length || /\s/.test(text[pos]!)) return null;
	let start = pos;
	let end = pos;
	while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
	while (end < text.length && !/\s/.test(text[end]!)) end++;
	return { start, end };
}

function getQuoteBoundaries(
	text: string, pos: number, quote: string, inner: boolean
): { start: number; end: number } | null {
	const quotes: number[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === quote && (i === 0 || text[i - 1] !== "\\")) quotes.push(i);
	}

	// Find the pair containing pos
	for (let i = 0; i < quotes.length - 1; i += 2) {
		const start = quotes[i]!, end = quotes[i + 1]!;
		if (pos >= start && pos <= end) {
			return inner ? { start: start + 1, end } : { start, end: end + 1 };
		}
	}

	// Try: cursor is before a quote pair on the same line
	for (let i = 0; i < quotes.length - 1; i += 2) {
		const start = quotes[i]!, end = quotes[i + 1]!;
		if (start > pos) {
			if (!text.slice(pos, start).includes("\n")) {
				return inner ? { start: start + 1, end } : { start, end: end + 1 };
			}
			break;
		}
	}

	return null;
}

function getBracketBoundaries(
	text: string, pos: number, openBracket: string, closeBracket: string, inner: boolean
): { start: number; end: number } | null {
	let depth = 0;
	let openPos = -1;

	// Search backwards for opening bracket
	for (let i = pos; i >= 0; i--) {
		if (text[i] === closeBracket) depth++;
		else if (text[i] === openBracket) {
			if (depth === 0) { openPos = i; break; }
			depth--;
		}
	}

	if (openPos === -1) {
		// Try searching forward if cursor is before opening bracket
		for (let i = pos; i < text.length; i++) {
			if (text[i] === openBracket) { openPos = i; break; }
			if (text[i] === closeBracket) break;
		}
	}
	if (openPos === -1) return null;

	// Search forwards for matching closing bracket
	depth = 0;
	let closePos = -1;
	for (let i = openPos; i < text.length; i++) {
		if (text[i] === openBracket) depth++;
		else if (text[i] === closeBracket) {
			depth--;
			if (depth === 0) { closePos = i; break; }
		}
	}
	if (closePos === -1) return null;

	// Check if pos is within the brackets
	if (pos < openPos || pos > closePos) {
		if (pos < openPos && text.slice(pos, openPos).includes("\n")) return null;
		if (pos > closePos) return null;
	}

	return inner ? { start: openPos + 1, end: closePos } : { start: openPos, end: closePos + 1 };
}

/**
 * Resolve a text object motion (e.g., "iw", "a(", "i\"") to a range.
 */
function resolveTextObject(
	text: string, pos: number, motion: string, count: number = 1
): { start: number; end: number } | null {
	if (motion.length !== 2) return null;
	const inner = motion[0] === "i";
	const obj = motion[1]!;

	if (obj === "w") {
		const range = getInnerWord(text, pos);
		if (!range) return null;
		let end = range.end;
		for (let i = 1; i < count; i++) {
			const next = getInnerWord(text, findNextWORDStart(text, end));
			if (!next) break;
			end = next.end;
		}
		if (!inner) while (end < text.length && /\s/.test(text[end]!)) end++;
		return { start: range.start, end };
	}
	if ("'\"`".includes(obj)) {
		return getQuoteBoundaries(text, pos, obj, inner);
	}
	const pair = BRACKET_PAIRS[obj];
	if (pair) {
		let range = getBracketBoundaries(text, pos, pair[0], pair[1], false);
		for (let i = 1; i < count && range; i++) {
			const outer = getBracketBoundaries(text, range.start - 1, pair[0], pair[1], false);
			if (!outer || outer.start >= range.start || outer.end < range.end) return null;
			range = outer;
		}
		return range && inner ? { start: range.start + 1, end: range.end - 1 } : range;
	}
	return null;
}

// ============================================================================
// ViEditor class
// ============================================================================

class ViEditor extends CustomEditor {
	private mode: Mode = "insert";
	private pendingOperator: Operator = null;
	private pendingCount: number = 0;
	private operatorCount: number = 0;
	private pendingFind: FindMotionType | null = null;
	private pendingR: boolean = false;
	private pendingTextObject: "i" | "a" | null = null;
	private pendingG: boolean = false;

	// Last find motion for ; and , repeat
	private lastFindMotion: { type: FindMotionType; char: string } | null = null;

	// Dot repeat state
	private changeKeys: string[] = [];
	private changeStartText: string | undefined;
	private lastChange: string[] = [];
	private replaying: boolean = false;
	private insertInputs: string[] = [];
	private insertCount: number = 1;
	private insertNewLines: boolean = false;

	// Callback for mode changes (to update status bar)
	onModeChange?: (mode: Mode) => void;

	constructor(
		tui: TUI, theme: EditorTheme,
		private readonly viKeybindings: KeybindingsManager,
		private readonly writeClipboard: (text: string) => Promise<void>,
		private readonly showIndicator: boolean,
	) {
		super(tui, theme, viKeybindings, { paddingX: 2, embedWorkingStatus: true });
	}

	private setMode(newMode: Mode): void {
		if (this.mode !== newMode) {
			this.mode = newMode;
			if (newMode === "insert") {
				this.insertInputs = [];
				this.insertCount = 1;
				this.insertNewLines = false;
			}
			this.onModeChange?.(newMode);
		}
	}

	getMode(): Mode {
		return this.mode;
	}

	private enterInsert(count: number = 1, newLines: boolean = false): void {
		this.setMode("insert");
		this.insertCount = count;
		this.insertNewLines = newLines;
	}

	private finishInsert(): void {
		for (let i = 1; i < this.insertCount; i++) {
			if (this.insertNewLines) super.handleInput("\n");
			for (const input of this.insertInputs) super.handleInput(input);
		}
		this.insertInputs = [];
		this.insertCount = 1;
		this.insertNewLines = false;
	}

	private resetPending(): void {
		this.pendingOperator = null;
		this.pendingCount = 0;
		this.operatorCount = 0;
		this.pendingFind = null;
		this.pendingR = false;
		this.pendingTextObject = null;
		this.pendingG = false;
	}

	private getCount(): number {
		return (this.operatorCount || 1) * (this.pendingCount || 1);
	}

	private accumCount(digit: number): void {
		this.pendingCount = this.pendingCount * 10 + digit;
	}

	// --- Dot repeat helpers ---

	private hasPendingCommand(): boolean {
		return this.pendingCount > 0 || this.pendingOperator !== null || this.pendingFind !== null
			|| this.pendingR || this.pendingTextObject !== null || this.pendingG;
	}

	private clearRecording(): void {
		this.changeKeys = [];
		this.changeStartText = undefined;
	}

	private repeatLastChange(count: number | undefined): void {
		let keys = [...this.lastChange];
		if (count !== undefined && keys.length > 0) {
			while (/^\d$/.test(keys[0] ?? "")) keys.shift();
			if (["c", "d", "y"].includes(keys[0]!) && /^[1-9]$/.test(keys[1] ?? "")) {
				while (/^\d$/.test(keys[1] ?? "")) keys.splice(1, 1);
			}
			keys = [...String(count), ...keys];
		}
		const before = this.getText();
		this.resetPending();
		this.replaying = true;
		try {
			for (const key of keys) this.handleInput(key);
		} finally {
			this.replaying = false;
		}
		if (this.getText() !== before) this.lastChange = keys;
	}

	// --- Cursor / text helpers ---

	private runEditorAction(action: EditorAction, count: number = 1): void {
		for (const key of this.viKeybindings.getKeys(action)) {
			const input = keyInput(key);
			if (input === undefined || !this.viKeybindings.matches(input, action)) continue;
			// Internal motions must not invoke app actions or extension shortcuts sharing the key.
			for (let i = 0; i < count; i++) Editor.prototype.handleInput.call(this, input);
			return;
		}
	}


	private getCursorOffset(): number {
		const lines = this.getLines();
		const cursor = this.getCursor();
		let offset = 0;
		for (let i = 0; i < cursor.line; i++) {
			offset += (lines[i]?.length ?? 0) + 1;
		}
		offset += cursor.col;
		return offset;
	}

	private setCursorOffset(targetOffset: number): void {
		const text = this.getText();
		const lines = text.split("\n");
		let offset = 0;
		let targetLine = 0;
		let targetCol = 0;

		for (let i = 0; i < lines.length; i++) {
			const lineLen = lines[i]!.length;
			if (offset + lineLen >= targetOffset) {
				targetLine = i;
				targetCol = targetOffset - offset;
				break;
			}
			offset += lineLen + 1;
			targetLine = i;
			targetCol = lineLen;
		}

		const cursor = this.getCursor();
		const lineDiff = targetLine - cursor.line;
		if (lineDiff > 0) this.runEditorAction("tui.editor.cursorDown", lineDiff);
		else if (lineDiff < 0) this.runEditorAction("tui.editor.cursorUp", -lineDiff);

		this.runEditorAction("tui.editor.cursorLineStart");
		if (targetCol > 0) this.runEditorAction("tui.editor.cursorRight", targetCol);
	}

	/** Move cursor to a flat offset by computing delta from current position. */
	private moveToOffset(targetOffset: number): void {
		const diff = targetOffset - this.getCursorOffset();
		if (diff > 0) this.runEditorAction("tui.editor.cursorRight", diff);
		else if (diff < 0) this.runEditorAction("tui.editor.cursorLeft", -diff);
	}

	/**
	 * Get the current line's start and the counted target line's end.
	 * Used by D, C, S, and the $ operator motion.
	 */
	private getLineOffsets(count: number = 1): { lineStart: number; lineEnd: number } {
		const lines = this.getLines();
		const cursor = this.getCursor();
		let lineStart = 0;
		for (let i = 0; i < cursor.line; i++) {
			lineStart += (lines[i]?.length ?? 0) + 1;
		}
		let lineEnd = lineStart;
		const endLine = Math.min(cursor.line + count, lines.length);
		for (let i = cursor.line; i < endLine; i++) {
			if (i > cursor.line) lineEnd++;
			lineEnd += lines[i]!.length;
		}
		return { lineStart, lineEnd };
	}

	/** Compute line range offsets for line-wise operations (dd, dj, dk, etc.). */
	private getLineRangeOffsets(startLine: number, endLine: number): { startOffset: number; endOffset: number } {
		const lines = this.getLines();
		const text = this.getText();
		let startOffset = 0;
		for (let i = 0; i < startLine; i++) {
			startOffset += (lines[i]?.length ?? 0) + 1;
		}
		let endOffset = startOffset;
		for (let i = startLine; i < endLine; i++) {
			endOffset += (lines[i]?.length ?? 0) + 1;
		}
		if (endOffset > text.length) endOffset = text.length;
		return { startOffset, endOffset };
	}

	// --- Register / clipboard ---

	private saveToRegister(text: string, lineWise: boolean = false): void {
		internalRegister = { text, lineWise };
		if (CLIPBOARD_WRITE_THROUGH) void this.writeClipboard(text);
	}

	private getFromRegister(): Register {
		if (clipboardReadEnabled) {
			const clip = pasteFromClipboard();
			// A non-null, non-empty clipboard read wins; anything else falls back
			// to the internal register. Clipboard reads are always treated as
			// char-wise (the OS clipboard carries no line-wise flag).
			if (clip !== null && clip.length > 0) return { text: clip, lineWise: false };
		}
		return internalRegister;
	}

	/**
	 * Char-wise paste (register from x, dw, yw, etc.).
	 * p inserts after the cursor; P inserts at the cursor. Cursor lands on the
	 * last pasted character, matching vim.
	 */
	private pasteCharWise(regText: string, count: number, before: boolean): void {
		const pasteText = regText.repeat(count);
		if (!before) this.runEditorAction("tui.editor.cursorRight");
		const offset = this.getCursorOffset();
		const text = this.getText();
		this.setText(text.slice(0, offset) + pasteText + text.slice(offset));
		this.setCursorOffset(offset + pasteText.length - 1);
	}

	/**
	 * Line-wise paste (register from dd, yy, dj, Y, etc.).
	 * p opens the pasted line(s) below the current line, P above it. The register
	 * text is normalized to whole lines (each ending in \n); the cursor lands at
	 * the start of the first pasted line, matching vim's line-wise p/P.
	 */
	private pasteLineWise(regText: string, count: number, before: boolean): void {
		// Normalize: guarantee a single trailing newline, then repeat by count.
		const oneCopy = regText.endsWith("\n") ? regText : regText + "\n";
		const block = oneCopy.repeat(count);

		const { lineStart, lineEnd } = this.getLineOffsets();
		const text = this.getText();
		let insertAt: number;
		if (before) {
			insertAt = lineStart;
			this.setText(text.slice(0, insertAt) + block + text.slice(insertAt));
		} else {
			// Insert after the current line. lineEnd points at the current line's
			// trailing \n (or end-of-buffer for the last line). When there is no
			// trailing \n we must add one before the block so it starts on a new line.
			const hasNewlineAfter = lineEnd < text.length; // there is a \n at lineEnd
			if (hasNewlineAfter) {
				insertAt = lineEnd + 1; // just past the current line's \n
				this.setText(text.slice(0, insertAt) + block + text.slice(insertAt));
			} else {
				insertAt = lineEnd + 1; // account for the \n we insert next
				this.setText(text.slice(0, lineEnd) + "\n" + block.replace(/\n$/, "") + text.slice(lineEnd));
			}
		}
		this.setCursorOffset(insertAt);
	}

	// --- Operator execution ---

	private deleteRange(
		startOffset: number, endOffset: number,
		saveToClipboard: boolean = true, lineWise: boolean = false,
	): void {
		const text = this.getText();
		const deleted = text.slice(startOffset, endOffset);
		if (saveToClipboard && deleted) this.saveToRegister(deleted, lineWise);
		this.setText(text.slice(0, startOffset) + text.slice(endOffset));
		this.setCursorOffset(startOffset);
	}

	private yankRange(startOffset: number, endOffset: number, lineWise: boolean = false): void {
		const text = this.getText();
		const yanked = text.slice(startOffset, endOffset);
		if (yanked) this.saveToRegister(yanked, lineWise);
	}

	private executeOperator(op: Operator, startOffset: number, endOffset: number, lineWise: boolean = false): void {
		if (startOffset > endOffset) [startOffset, endOffset] = [endOffset, startOffset];
		switch (op) {
			case "d": this.deleteRange(startOffset, endOffset, true, lineWise); break;
			case "c": this.deleteRange(startOffset, endOffset, true, lineWise); this.setMode("insert"); break;
			case "y": this.yankRange(startOffset, endOffset, lineWise); break;
		}
	}

	// --- Operator + motion ---

	/**
	 * Handle operator + motion combination.
	 * Computes the target offset for a motion, then applies the pending operator.
	 */
	private handleOperatorMotion(motion: string): void {
		const op = this.pendingOperator;
		const count = this.getCount();
		const text = this.getText();
		const startOffset = this.getCursorOffset();
		let endOffset = startOffset;

		// Word motions (w, b, e, W, B, E)
		const wordFn = WORD_MOTION_FN[motion];
		if (wordFn) {
			endOffset = startOffset;
			for (let i = 0; i < count; i++) endOffset = wordFn(text, endOffset);
		}
		// Line position motions
		else if (motion === "$") {
			endOffset = this.getLineOffsets(count).lineEnd;
		} else if (motion === "0") {
			endOffset = startOffset - this.getCursor().col;
		}
		// Text objects (iw, aw, i", a(, etc.)
		else if (motion.length === 2 && (motion[0] === "i" || motion[0] === "a")) {
			const range = resolveTextObject(text, startOffset, motion, count);
			if (range) {
				this.executeOperator(op, range.start, range.end);
			}
			this.resetPending();
			return;
		} else {
			this.resetPending();
			return;
		}

		if (endOffset !== startOffset) {
			this.executeOperator(op, startOffset, endOffset);
		}
		this.resetPending();
	}

	// --- Find motions (f/F/t/T) ---

	/**
	 * Unified handler for f, F, t, T motions.
	 * Searches for char on the current line, applies operator or moves cursor.
	 */
	private handleFindMotion(type: FindMotionType, char: string): void {
		const count = this.getCount();
		const lines = this.getLines();
		const cursor = this.getCursor();
		const line = lines[cursor.line] ?? "";

		const forward = type === "f" || type === "t";
		const till = type === "t" || type === "T";

		// Search for the Nth occurrence
		let found = 0;
		let foundCol = -1;
		if (forward) {
			for (let i = cursor.col + 1; i < line.length; i++) {
				if (line[i] === char && ++found === count) { foundCol = i; break; }
			}
		} else {
			for (let i = cursor.col - 1; i >= 0; i--) {
				if (line[i] === char && ++found === count) { foundCol = i; break; }
			}
		}

		if (found >= count && foundCol >= 0) {
			const targetCol = till ? (forward ? foundCol - 1 : foundCol + 1) : foundCol;
			const moved = forward ? targetCol > cursor.col : targetCol < cursor.col;

			if (moved) {
				if (this.pendingOperator) {
					const startOffset = this.getCursorOffset();
					// For operators: f/t forward include up to foundCol (+1), backward exclude per till
					const endOffset = forward
						? startOffset + (foundCol - cursor.col) + (till ? 0 : 1)
						: startOffset - (cursor.col - foundCol) + (till ? 1 : 0);
					this.executeOperator(this.pendingOperator, startOffset, endOffset);
				} else {
					const moves = Math.abs(targetCol - cursor.col);
					this.runEditorAction(forward ? "tui.editor.cursorRight" : "tui.editor.cursorLeft", moves);
				}
			}
		}

		this.lastFindMotion = { type, char };
		this.resetPending();
	}

	/** Repeat last find motion (;) or reverse it (,). */
	private repeatFindMotion(reverse: boolean): void {
		if (!this.lastFindMotion) { this.resetPending(); return; }
		const { type, char } = this.lastFindMotion;
		this.handleFindMotion(reverse ? FIND_REVERSE[type] : type, char);
	}

	// --- Main input handler ---

	handleInput(data: string): void {
		if (this.replaying) {
			this.handleViInput(data);
			return;
		}
		if (this.mode === "normal" && !this.pendingFind && !this.pendingR
			&& !this.pendingTextObject && !this.pendingG
			&& (data === "." || data === "u" || this.viKeybindings.matches(data, "tui.editor.undo")
				|| this.viKeybindings.matches(data, "tui.input.submit"))) {
			this.clearRecording();
			this.handleViInput(data);
			return;
		}
		if (this.changeStartText === undefined) {
			this.changeStartText = this.getText();
			this.changeKeys = this.mode === "insert" ? ["i"] : [];
		}
		if (this.pendingOperator && (data === ";" || data === ",") && this.lastFindMotion) {
			const { type, char } = this.lastFindMotion;
			this.changeKeys.push(data === "," ? FIND_REVERSE[type] : type, char);
		} else {
			this.changeKeys.push(data);
		}
		this.handleViInput(data);
		if (this.mode === "normal" && !this.hasPendingCommand()) {
			if (this.getText() !== this.changeStartText) this.lastChange = [...this.changeKeys];
			this.clearRecording();
		}
	}

	private handleViInput(data: string): void {
		// Leave insert mode, but let Pi count Escape on an empty prompt.
		// Forward each physical key once so Pi owns double-Escape timing.
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.finishInsert();
				this.setMode("normal");
				this.resetPending();
				if (!this.replaying && !this.getText().trim()) super.handleInput(data);
				return;
			}
			this.resetPending();
			super.handleInput(data);
			return;
		}

		// Insert mode: pass everything to CustomEditor
		if (this.mode === "insert") {
			this.insertInputs.push(data);
			super.handleInput(data);
			if (this.viKeybindings.matches(data, "tui.input.submit") && this.getText() === "") {
				this.clearRecording();
				this.insertInputs = [];
				this.insertCount = 1;
				this.insertNewLines = false;
			}
			return;
		}

		// ============ Normal mode ============

		// Pending find motion (f/F/t/T waiting for char)
		if (this.pendingFind && data.length === 1) {
			this.handleFindMotion(this.pendingFind, data);
			return;
		}

		// Pending r{char}
		if (this.pendingR && data.length === 1) {
			const count = this.getCount();
			const offset = this.getCursorOffset();
			const text = this.getText();
			const endOffset = Math.min(offset + count, text.length);
			if (offset < text.length) {
				const newText = text.slice(0, offset) + data.repeat(endOffset - offset) + text.slice(endOffset);
				this.setText(newText);
				this.setCursorOffset(offset);
			}
			this.resetPending();
			return;
		}

		// Pending gg
		if (this.pendingG) {
			if (data === "g") {
				const line = Math.min(this.getCount(), this.getLines().length) - 1;
				this.setCursorOffset(this.getLineRangeOffsets(line, line).startOffset);
			}
			this.resetPending();
			return;
		}

		// Pending text object (operator + i/a + object char)
		if (this.pendingTextObject && this.pendingOperator) {
			const objectType = this.pendingTextObject + data;
			if (/^[ia][w'"`()\[\]{}<>]$/.test(objectType)) {
				this.handleOperatorMotion(objectType);
				return;
			}
			this.resetPending();
			return;
		}

		// Text object initiation after operator
		if (this.pendingOperator && (data === "i" || data === "a")) {
			this.pendingTextObject = data as "i" | "a";
			return;
		}

		// Count accumulation
		if (/^[1-9]$/.test(data) || (data === "0" && this.pendingCount > 0)) {
			this.accumCount(parseInt(data, 10));
			return;
		}

		// Operators (c/d/y) — double press = line-wise (dd, cc, yy)
		if (data === "c" || data === "d" || data === "y") {
			if (this.pendingOperator === data) {
				const cursor = this.getCursor();
				const count = this.getCount();
				const endLine = Math.min(cursor.line + count, this.getLines().length);
				const { startOffset, endOffset } = this.getLineRangeOffsets(cursor.line, endLine);
				this.executeOperator(data as Operator, startOffset, endOffset, true);
				this.resetPending();
				return;
			}
			this.operatorCount = this.getCount();
			this.pendingCount = 0;
			this.pendingOperator = data as Operator;
			return;
		}

		// Dot repeat
		if (data === ".") {
			this.repeatLastChange(this.pendingCount > 0 ? this.getCount() : undefined);
			return;
		}

		// --- Motions and commands ---
		const count = this.getCount();

		switch (data) {
			// Basic movement
			case "h":
				if (this.pendingOperator) {
					const start = this.getCursorOffset();
					this.executeOperator(this.pendingOperator, start, Math.max(0, start - count));
				} else {
					this.runEditorAction("tui.editor.cursorLeft", count);
				}
				this.resetPending();
				return;

			case "j":
				if (this.pendingOperator) {
					const cursor = this.getCursor();
					const endLine = Math.min(cursor.line + count + 1, this.getLines().length);
					const { startOffset, endOffset } = this.getLineRangeOffsets(cursor.line, endLine);
					this.executeOperator(this.pendingOperator, startOffset, endOffset, true);
					this.resetPending();
				} else {
					this.runEditorAction("tui.editor.cursorDown", count);
					this.resetPending();
				}
				return;

			case "k":
				if (this.pendingOperator) {
					const cursor = this.getCursor();
					const startLine = Math.max(cursor.line - count, 0);
					const { startOffset, endOffset } = this.getLineRangeOffsets(startLine, cursor.line + 1);
					this.executeOperator(this.pendingOperator, startOffset, endOffset, true);
					this.resetPending();
				} else {
					this.runEditorAction("tui.editor.cursorUp", count);
					this.resetPending();
				}
				return;

			case "l":
				if (this.pendingOperator) {
					const start = this.getCursorOffset();
					this.executeOperator(this.pendingOperator, start, Math.min(this.getText().length, start + count));
				} else {
					this.runEditorAction("tui.editor.cursorRight", count);
				}
				this.resetPending();
				return;

			case "0":
				if (this.pendingOperator) this.handleOperatorMotion("0");
				else { this.runEditorAction("tui.editor.cursorLineStart"); this.resetPending(); }
				return;

			case "$":
				if (this.pendingOperator) this.handleOperatorMotion("$");
				else { this.setCursorOffset(this.getLineOffsets(count).lineEnd); this.resetPending(); }
				return;

			// Word motions with operator support
			case "w":
				if (this.pendingOperator) {
					this.handleOperatorMotion("w");
				} else {
					this.runEditorAction("tui.editor.cursorWordRight", count);
					this.resetPending();
				}
				return;

			case "b":
				if (this.pendingOperator) {
					this.handleOperatorMotion("b");
				} else {
					this.runEditorAction("tui.editor.cursorWordLeft", count);
					this.resetPending();
				}
				return;

			case "e":
				if (this.pendingOperator) {
					this.handleOperatorMotion("e");
				} else {
					let target = this.getCursorOffset();
					for (let i = 0; i < count; i++) {
						target = Math.max(0, findWordEnd(this.getText(), target + 1) - 1);
					}
					this.moveToOffset(target);
					this.resetPending();
				}
				return;

			case "W":
				if (this.pendingOperator) {
					this.handleOperatorMotion("W");
				} else {
					let off = this.getCursorOffset();
					for (let i = 0; i < count; i++) off = findNextWORDStart(this.getText(), off);
					this.moveToOffset(off);
					this.resetPending();
				}
				return;

			case "B":
				if (this.pendingOperator) {
					this.handleOperatorMotion("B");
				} else {
					let off = this.getCursorOffset();
					for (let i = 0; i < count; i++) off = findPrevWORDStart(this.getText(), off);
					this.moveToOffset(off);
					this.resetPending();
				}
				return;

			case "E":
				if (this.pendingOperator) {
					this.handleOperatorMotion("E");
				} else {
					let off = this.getCursorOffset();
					for (let i = 0; i < count; i++) off = Math.max(0, findWORDEnd(this.getText(), off + 1) - 1);
					this.moveToOffset(off);
					this.resetPending();
				}
				return;

			// Paste
			case "p": {
				const reg = this.getFromRegister();
				if (reg.text) {
					if (reg.lineWise) this.pasteLineWise(reg.text, count, false);
					else this.pasteCharWise(reg.text, count, false);
				}
				this.resetPending();
				return;
			}
			case "P": {
				const reg = this.getFromRegister();
				if (reg.text) {
					if (reg.lineWise) this.pasteLineWise(reg.text, count, true);
					else this.pasteCharWise(reg.text, count, true);
				}
				this.resetPending();
				return;
			}

			// Yank line
			case "Y": {
				const yCursor = this.getCursor();
				const endLine = Math.min(yCursor.line + count, this.getLines().length);
				const { startOffset, endOffset } = this.getLineRangeOffsets(yCursor.line, endLine);
				const yanked = this.getText().slice(startOffset, endOffset);
				this.saveToRegister(yanked.endsWith("\n") ? yanked : yanked + "\n", true);
				this.resetPending();
				return;
			}

			// Find motions
			case "f": this.pendingFind = "f"; return;
			case "F": this.pendingFind = "F"; return;
			case "t": this.pendingFind = "t"; return;
			case "T": this.pendingFind = "T"; return;
			case ";": this.repeatFindMotion(false); return;
			case ",": this.repeatFindMotion(true); return;

			// Replace character
			case "r": this.pendingR = true; return;

			// Mode switching
			case "i": this.enterInsert(count); this.resetPending(); return;
			case "a": this.enterInsert(count); this.runEditorAction("tui.editor.cursorRight"); this.resetPending(); return;
			case "I": this.enterInsert(count); this.runEditorAction("tui.editor.cursorLineStart"); this.resetPending(); return;
			case "A": this.enterInsert(count); this.runEditorAction("tui.editor.cursorLineEnd"); this.resetPending(); return;

			case "o":
				this.runEditorAction("tui.editor.cursorLineEnd");
				super.handleInput("\n");
				this.enterInsert(count, true);
				this.resetPending();
				return;

			case "O":
				this.runEditorAction("tui.editor.cursorLineStart");
				super.handleInput("\n");
				this.runEditorAction("tui.editor.cursorUp");
				this.enterInsert(count, true);
				this.resetPending();
				return;

			// Delete chars
			case "x": {
				const offset = this.getCursorOffset();
				const end = Math.min(offset + count, this.getText().length);
				if (end > offset) this.deleteRange(offset, end);
				this.resetPending();
				return;
			}
			case "X": {
				const offset = this.getCursorOffset();
				const start = Math.max(offset - count, 0);
				if (offset > start) this.deleteRange(start, offset);
				this.resetPending();
				return;
			}

			// Delete to end of line
			case "D":
				this.deleteRange(this.getCursorOffset(), this.getLineOffsets(count).lineEnd);
				this.resetPending();
				return;

			// Change to end of line
			case "C":
				this.deleteRange(this.getCursorOffset(), this.getLineOffsets(count).lineEnd);
				this.setMode("insert");
				this.resetPending();
				return;

			// Substitute char(s)
			case "s": {
				const offset = this.getCursorOffset();
				const end = Math.min(offset + count, this.getText().length);
				if (end > offset) this.deleteRange(offset, end);
				this.setMode("insert");
				this.resetPending();
				return;
			}

			// Substitute counted lines (like cc), keeping a line-wise register and
			// one blank line for the replacement text.
			case "S": {
				this.runEditorAction("tui.editor.cursorLineStart");
				const { lineStart, lineEnd } = this.getLineOffsets(count);
				const text = this.getText();
				const hasNewlineAfter = lineEnd < text.length;
				// Register content is the line plus its trailing newline (line-wise).
				const lineText = text.slice(lineStart, lineEnd) + (hasNewlineAfter ? "\n" : "");
				if (lineText) this.saveToRegister(lineText.endsWith("\n") ? lineText : lineText + "\n", true);
				// Delete only the line content (keep the line itself for retyping).
				this.deleteRange(lineStart, lineEnd, false);
				this.setMode("insert");
				this.resetPending();
				return;
			}

			// Undo. Vi edits go through setText(), which pushes an undo snapshot on the
			// base editor whenever the content changes, so we can delegate to the base
			// editor's undo by forwarding its bound key sequence. Count-aware (e.g. 3u).
			case "u":
				this.runEditorAction("tui.editor.undo", count);
				this.resetPending();
				return;

			// Go to beginning / end
			case "g": this.pendingG = true; return;
			case "G": {
				const line = Math.min(count, this.getLines().length) - 1;
				this.setCursorOffset(this.pendingCount > 0
					? this.getLineRangeOffsets(line, line).startOffset : this.getText().length);
				this.resetPending();
				return;
			}
		}

		// Pass control sequences to super, ignore printable chars in normal mode
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.resetPending();
			return;
		}

		super.handleInput(data);
		this.resetPending();
	}

	// --- Rendering ---

	private cursorMode: Mode | undefined;

	private updateCursorStyle(): void {
		if (!this.focused || !this.tui.getShowHardwareCursor()) {
			this.restoreCursor();
			return;
		}
		if (this.cursorMode !== this.mode) {
			// DECSCUSR: steady beam in insert mode, steady block in normal mode.
			this.tui.terminal.write(this.mode === "insert" ? "\x1b[6 q" : "\x1b[2 q");
			this.cursorMode = this.mode;
		}
	}

	restoreCursor(): void {
		if (this.cursorMode === undefined) return;
		this.tui.terminal.write("\x1b[0 q");
		this.cursorMode = undefined;
	}

	/**
	 * Insert the starship-style mode indicator (❯/❮) into the first content line.
	 *
	 * COUPLING NOTE: Assumes the render output structure of CustomEditor is:
	 *   [top border, content lines..., bottom border]
	 * and that content lines start with padding spaces (paddingX=2, set by this class).
	 * The first space of padding on lines[1] is replaced with the indicator.
	 */
	private insertPromptIndicator(lines: string[]): void {
		if (lines.length < 3) return;
		const promptChar = this.mode === "insert"
			? `\x1b[32m${INSERT_INDICATOR}\x1b[0m`
			: `\x1b[33m${NORMAL_INDICATOR}\x1b[0m`;
		const firstContentLine = lines[1]!;
		if (firstContentLine.startsWith(" ")) {
			lines[1] = promptChar + firstContentLine.slice(1);
		}
	}

	render(width: number): string[] {
		this.updateCursorStyle();
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		if (this.mode === "insert" && !this.tui.getShowHardwareCursor()) {
			// Keep the software underline when Pi's hardware cursor is disabled.
			for (let i = 0; i < lines.length; i++) {
				lines[i] = lines[i]!.replace(/\x1b_pi:fc\x07(.*?)\x1b_pi:\/fc\x07/s, '\x1b[4m$1\x1b[24m');
			}
		}

		if (this.showIndicator) this.insertPromptIndicator(lines);

		// Show pending state in bottom border
		let pending = "";
		if (this.operatorCount > 1) pending += this.operatorCount;
		if (this.pendingOperator) pending += this.pendingOperator;
		if (this.pendingCount > 0) pending += this.pendingCount;
		if (this.pendingFind) pending += this.pendingFind;
		if (this.pendingR) pending += "r";
		if (this.pendingG) pending += "g";

		if (pending) {
			const label = ` [${pending}] `;
			const lastIdx = lines.length - 1;
			const lastLine = lines[lastIdx]!;
			if (visibleWidth(lastLine) >= label.length) {
				lines[lastIdx] = truncateToWidth(lastLine, width - visibleWidth(label), "") + label;
			}
		}

		return lines;
	}
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (
	pi: ExtensionAPI,
	copyClipboard: (text: string) => Promise<void> = copyToClipboard,
) {
	let viModeEnabled = true;
	let showIndicator = true;
	let currentEditor: ViEditor | null = null;
	let clipboardContext: Pick<ExtensionContext, "ui"> | undefined;
	let pendingClipboardText: string | undefined;
	let clipboardWrite: Promise<void> | undefined;
	let clipboardWarningShown = false;

	const writeClipboard = (text: string): Promise<void> => {
		pendingClipboardText = text;
		clipboardWrite ??= Promise.resolve().then(async () => {
			try {
				while (pendingClipboardText !== undefined) {
					const next = pendingClipboardText;
					pendingClipboardText = undefined;
					try {
						await copyClipboard(next);
					} catch {
						if (!clipboardWarningShown) {
							clipboardWarningShown = true;
							clipboardContext?.ui.notify("Vi-mode: Clipboard copy failed; the internal register is still available.", "warning");
						}
					}
				}
			} finally {
				clipboardWrite = undefined;
			}
		});
		return clipboardWrite;
	};

	const updateStatus = (ctx: Pick<ExtensionContext, "ui">, mode: Mode) => {
		const modeStr = mode === "insert" ? "INSERT" : "NORMAL";
		const color = mode === "insert" ? "success" : "warning";
		ctx.ui.setStatus("vi-mode",
			ctx.ui.theme.fg("dim", "vi ") + ctx.ui.theme.fg(color, `[${modeStr}]`)
		);
	};

	const enableViMode = (ctx: Pick<ExtensionContext, "ui">) => {
		clipboardContext = ctx;
		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, kb: KeybindingsManager) => {
			currentEditor?.restoreCursor();
			currentEditor = new ViEditor(tui, theme, kb, writeClipboard, showIndicator);
			currentEditor.onModeChange = (mode: Mode) => updateStatus(ctx, mode);
			return currentEditor;
		});
		updateStatus(ctx, "insert");
		viModeEnabled = true;
	};

	const disableViMode = (ctx: Pick<ExtensionContext, "ui">) => {
		currentEditor?.restoreCursor();
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setStatus("vi-mode", undefined);
		currentEditor = null;
		viModeEnabled = false;
	};

	pi.on("session_start", (_event, ctx) => {
		const settings = getSettingsManager(ctx.cwd);
		const { viMode } = settings.getSettings() as ReturnType<SettingsManager["getSettings"]> & {
			viMode?: { showIndicator?: boolean; showPaddingWarning?: boolean };
		};
		showIndicator = viMode?.showIndicator !== false;
		enableViMode(ctx);
		if (showIndicator && viMode?.showPaddingWarning !== false && settings.getEditorPaddingX() < 1) {
			ctx.ui.notify("vi-mode: Editor padding is 0 — mode indicator (❯/❮) won't be shown. Set editorPaddingX > 0 in /settings.", "warning");
		}
	});

	pi.on("session_shutdown", () => {
		currentEditor?.restoreCursor();
	});

	pi.registerCommand("vi", {
		description: "Toggle vi-mode on/off (`/vi clipboard on|off` toggles OS clipboard paste)",
		handler: async (args, ctx) => {
			if (args === "clipboard on" || args === "clipboard off") {
				clipboardReadEnabled = args === "clipboard on";
				ctx.ui.notify(
					`Vi-mode: paste from OS clipboard ${clipboardReadEnabled ? "enabled" : "disabled"}`,
					"info",
				);
			} else if (args === "on") {
				enableViMode(ctx);
				ctx.ui.notify("Vi-mode enabled", "info");
			} else if (args === "off") {
				disableViMode(ctx);
				ctx.ui.notify("Vi-mode disabled", "info");
			} else {
				if (viModeEnabled) {
					disableViMode(ctx);
					ctx.ui.notify("Vi-mode disabled", "info");
				} else {
					enableViMode(ctx);
					ctx.ui.notify("Vi-mode enabled", "info");
				}
			}
		},
	});

	pi.registerShortcut("ctrl+shift+v", {
		description: "Toggle vi-mode",
		handler: async (ctx) => {
			if (viModeEnabled) {
				disableViMode(ctx);
				ctx.ui.notify("Vi-mode disabled", "info");
			} else {
				enableViMode(ctx);
				ctx.ui.notify("Vi-mode enabled", "info");
			}
		},
	});
}
