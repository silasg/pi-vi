import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// PI_TEST_HOST_DIR selects an installed Pi instead of the development dependency.
const hostDir = process.env.PI_TEST_HOST_DIR
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const hostImport = (relative) => import(pathToFileURL(path.join(hostDir, relative)).href);
const { DefaultResourceLoader, SettingsManager, createEventBus, createExtensionRuntime } = await hostImport("dist/index.js");
const { KeybindingsManager } = await hostImport("dist/core/keybindings.js");
const { StatusIndicator } = await hostImport("dist/modes/interactive/components/status-indicator.js");
const { loadExtensionFromFactory } = await hostImport("dist/core/extensions/loader.js");
const hostRequire = createRequire(path.join(hostDir, "package.json"));
const { getKeybindings, setKeybindings, isKittyProtocolActive, setKittyProtocolActive } = await import(pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href);
const { createJiti } = hostRequire("jiti");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  fsCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": path.join(hostDir, "dist/index.js"),
    "@earendil-works/pi-tui": hostRequire.resolve("@earendil-works/pi-tui"),
  },
});
const packageDir = process.env.PI_TEST_PACKAGE_DIR
  ?? path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// These are headless checks using Pi's actual loader and editor, not terminal QA.
test("package discovery, registration, and editor smoke checks", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "pi-vi-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
  // Prevent clipboard subprocesses from reaching the real clipboard.
  process.env.PATH = temporary;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(temporary, { recursive: true, force: true });
  });

  const settingsManager = SettingsManager.create(temporary, process.env.PI_CODING_AGENT_DIR);
  const loader = new DefaultResourceLoader({
    cwd: temporary,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager,
    additionalExtensionPaths: [packageDir],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1, "manifest must discover exactly one extension");
  const factoryModule = await jiti.import(result.extensions[0].resolvedPath, { default: true });
  const clipboardCopies = [];
  let clipboardGate;
  let failClipboard = false;
  const copyClipboard = async (text) => {
    clipboardCopies.push(text);
    if (clipboardGate) await clipboardGate;
    if (failClipboard) throw new Error("clipboard unavailable");
  };
  // Substitute only the clipboard I/O; use the installed Pi's loader and editor.
  const extension = await loadExtensionFromFactory(
    (api) => factoryModule(api, copyClipboard), temporary, createEventBus(), createExtensionRuntime(),
  );
  assert.ok(extension.commands.has("vi"));
  assert.ok(extension.shortcuts.has("ctrl+shift+v"));
  assert.equal(extension.handlers.get("session_start").length, 1);

  let editor;
  let factory;
  let editorKeybindings = new KeybindingsManager();
  const statuses = new Map();
  const notifications = [];
  const terminalWrites = [];
  let showHardwareCursor = false;
  const tui = {
    requestRender() {},
    terminal: { rows: 24, columns: 80, write: (data) => terminalWrites.push(data) },
    getShowHardwareCursor: () => showHardwareCursor,
    setShowHardwareCursor: (enabled) => { showHardwareCursor = enabled; },
  };
  const identity = (text) => text;
  const editorTheme = {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity, selectedText: identity, description: identity,
      scrollInfo: identity, noMatch: identity,
    },
  };
  const context = {
    cwd: temporary,
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus: (key, value) => statuses.set(key, value),
      notify: (...args) => notifications.push(args),
      setEditorComponent: (next) => {
        factory = next;
        editor = next?.(
          tui,
          editorTheme,
          editorKeybindings,
        );
      },
    },
  };
  await extension.handlers.get("session_start")[0]({ type: "session_start" }, context);
  assert.equal(editor.getMode(), "insert");
  assert.match(statuses.get("vi-mode"), /INSERT/);
  editor.handleInput("hello world");
  assert.equal(editor.getText(), "hello world");
  editor.handleInput("\x1b");
  assert.equal(editor.getMode(), "normal");
  assert.match(statuses.get("vi-mode"), /NORMAL/);
  editor.handleInput("0");
  assert.equal(editor.getCursor().col, 0);
  editor.handleInput("w");
  // w delegates to Pi's word-right action, which lands before the space here.
  assert.equal(editor.getCursor().col, 5);
  editor.handleInput("l");
  assert.equal(editor.getCursor().col, 6);
  editor.handleInput("i");
  editor.handleInput("new ");
  editor.handleInput("\x1b");
  assert.equal(editor.getText(), "hello new world");
  editor.handleInput("0");
  editor.handleInput("d");
  editor.handleInput("w");
  assert.equal(editor.getText(), "new world");
  editor.handleInput("P");
  assert.equal(editor.getText(), "hello new world");
  const rendered = editor.render(80);
  assert.ok(rendered.some((line) => line.includes("❮")), "normal indicator renders");
  editor.handleInput("i");
  assert.ok(editor.render(80).some((line) => line.includes("❯")), "insert indicator renders");

  for (const { viMode, padding, indicator, warning } of [
    { viMode: undefined, padding: 2, indicator: true, warning: false },
    { viMode: undefined, padding: 0, indicator: true, warning: true },
    { viMode: { showIndicator: false }, padding: 2, indicator: false, warning: false },
    { viMode: { showIndicator: false }, padding: 0, indicator: false, warning: false },
    { viMode: { showIndicator: true }, padding: 0, indicator: true, warning: true },
  ]) {
    await t.test(`indicator settings ${JSON.stringify(viMode)} with padding ${padding}`, async (st) => {
      st.mock.method(SettingsManager.prototype, "getSettings", () => ({ viMode }));
      st.mock.method(SettingsManager.prototype, "getEditorPaddingX", () => padding);
      notifications.length = 0;
      await extension.handlers.get("session_start")[0]({ type: "session_start" }, context);
      assert.equal(notifications.some(([message]) => message.includes("Editor padding")), warning);
      editor.setPaddingX(padding);
      editor.setText("draft");
      assert.equal(editor.render(80).some((line) => line.includes("❯")), indicator && padding > 0);
      editor.handleInput("\x1b");
      assert.equal(editor.render(80).some((line) => line.includes("❮")), indicator && padding > 0);
      assert.match(statuses.get("vi-mode"), /NORMAL/);
      editor.handleInput("d");
      assert.ok(editor.render(80).some((line) => line.includes("[d]")));
      await extension.commands.get("vi").handler("off", context);
      await extension.commands.get("vi").handler("on", context);
      editor.setPaddingX(padding);
      assert.equal(editor.render(80).some((line) => line.includes("❯")), indicator && padding > 0);
    });
  }
  await extension.handlers.get("session_start")[0]({ type: "session_start" }, context);

  for (const escape of ["\x1b", "\x1b[27u"]) {
    await t.test(`double Escape from insert mode (${JSON.stringify(escape)})`, async (st) => {
      st.mock.method(Date, "now", () => 10_000);
      await extension.commands.get("vi").handler("on", context);
      const current = editor;
      let interrupts = 0;
      let lastEscapeTime = 0;
      let doubleEscapes = 0;
      // Model Pi's empty-editor double-Escape handler, using the real CustomEditor.
      current.onEscape = () => {
        interrupts++;
        const now = Date.now();
        if (now - lastEscapeTime < 500) {
          doubleEscapes++;
          lastEscapeTime = 0;
        } else {
          lastEscapeTime = now;
        }
      };

      current.handleInput(escape);
      assert.equal(current.getMode(), "normal");
      assert.equal(interrupts, 1, "empty-prompt Escape must reach Pi immediately");
      current.handleInput(escape);
      assert.equal(interrupts, 2);
      assert.equal(doubleEscapes, 1, "two presses must trigger Pi's double-Escape action");
      current.handleInput(escape);
      assert.equal(interrupts, 3, "each physical Escape is forwarded exactly once");
    });
  }

  await t.test("insert Escape respects an already-armed Pi double-Escape handler", async (st) => {
    st.mock.method(Date, "now", () => 10_000);
    await extension.commands.get("vi").handler("on", context);
    const current = editor;
    let lastEscapeTime = 9_750;
    let actions = 0;
    current.onEscape = () => {
      const now = Date.now();
      if (now - lastEscapeTime < 500) {
        actions++;
        lastEscapeTime = 0;
      } else {
        lastEscapeTime = now;
      }
    };
    current.handleInput("\x1b");
    assert.equal(actions, 1);
    assert.equal(lastEscapeTime, 0, "do not re-arm Pi after triggering its action");
    current.handleInput("\x1b");
    assert.equal(actions, 1, "the next Escape starts a new pair");
  });

  await t.test("Escape-bound extension shortcuts run once per physical key", async () => {
    await extension.commands.get("vi").handler("on", context);
    const current = editor;
    let shortcuts = 0;
    let interrupts = 0;
    current.onExtensionShortcut = () => { shortcuts++; return true; };
    current.onEscape = () => { interrupts++; };
    current.handleInput("\x1b");
    assert.equal(shortcuts, 1);
    current.handleInput("\x1b");
    assert.equal(shortcuts, 2);
    assert.equal(interrupts, 0, "consuming shortcuts retain priority over app handling");
  });

  for (const scenario of ["timeout", "intervening key", "nonempty prompt", "whitespace prompt", "normal mode"]) {
    await t.test(`Escape forwarding: ${scenario}`, async (st) => {
      let now = 10_000;
      st.mock.method(Date, "now", () => now);
      await extension.commands.get("vi").handler("on", context);
      const current = editor;
      let interrupts = 0;
      let lastEscapeTime = 0;
      let doubleEscapes = 0;
      current.onEscape = () => {
        interrupts++;
        if (now - lastEscapeTime < 500) {
          doubleEscapes++;
          lastEscapeTime = 0;
        } else {
          lastEscapeTime = now;
        }
      };
      if (scenario === "nonempty prompt") current.setText("draft");
      if (scenario === "whitespace prompt") current.setText(" \n ");
      current.handleInput("\x1b");
      assert.equal(interrupts, scenario === "nonempty prompt" ? 0 : 1);
      if (scenario === "timeout") now += 500;
      if (scenario === "intervening key" || scenario === "normal mode") current.handleInput("h");
      current.handleInput("\x1b");
      assert.equal(interrupts, scenario === "nonempty prompt" ? 1 : 2);
      assert.equal(doubleEscapes, scenario === "timeout" || scenario === "nonempty prompt" ? 0 : 1);
      if (scenario === "normal mode") {
        current.handleInput("\x1b");
        assert.equal(interrupts, 3, "normal mode forwards each Escape unchanged");
      }
    });
  }

  await t.test("dot-repeat does not forward synthetic insert Escape", async () => {
    await extension.commands.get("vi").handler("on", context);
    const current = editor;
    let interrupts = 0;
    current.onEscape = () => { interrupts++; };
    current.setText("draft");
    for (const key of ["\x1b", "c", "c", "\x1b"]) current.handleInput(key);
    assert.equal(current.getText(), "");
    assert.equal(interrupts, 1);
    current.handleInput(".");
    assert.equal(interrupts, 1);
  });

  for (const initialHardwareCursor of [false, true]) {
    await t.test(`mode cursor respects hardware setting ${initialHardwareCursor}`, async () => {
      await extension.commands.get("vi").handler("off", context);
      showHardwareCursor = initialHardwareCursor;
      await extension.commands.get("vi").handler("on", context);
      editor.focused = true;
      editor.setText("Hello 世界");
      terminalWrites.length = 0;

      const lines = editor.render(80);
      assert.equal(showHardwareCursor, initialHardwareCursor);
      assert.deepEqual(terminalWrites, initialHardwareCursor ? ["\x1b[6 q"] : []);
      assert.ok(lines.some((line) => line.includes("\x1b_pi:c\x07")), "retain Pi's cursor position marker");
      assert.equal(lines.some((line) => line.includes("\x1b[4m")), !initialHardwareCursor);
      editor.render(80);
      assert.equal(terminalWrites.length, initialHardwareCursor ? 1 : 0, "unchanged renders do not resend the shape");

      editor.handleInput("\x1b");
      const normalLines = editor.render(80);
      assert.ok(normalLines.some((line) => line.includes("\x1b_pi:fc\x07")), "retain software block cursor");
      assert.equal(terminalWrites.at(-1), initialHardwareCursor ? "\x1b[2 q" : undefined);
      editor.handleInput("i");
      editor.render(80);
      assert.equal(terminalWrites.at(-1), initialHardwareCursor ? "\x1b[6 q" : undefined);

      editor.focused = false;
      editor.render(80);
      assert.equal(showHardwareCursor, initialHardwareCursor);
      assert.equal(terminalWrites.at(-1), initialHardwareCursor ? "\x1b[0 q" : undefined);
      editor.focused = true;
      editor.render(80);
      assert.equal(showHardwareCursor, initialHardwareCursor);
      assert.equal(terminalWrites.at(-1), initialHardwareCursor ? "\x1b[6 q" : undefined);
      await extension.commands.get("vi").handler("off", context);
      assert.equal(showHardwareCursor, initialHardwareCursor);
      assert.equal(terminalWrites.at(-1), initialHardwareCursor ? "\x1b[0 q" : undefined);

      await extension.commands.get("vi").handler("on", context);
      editor.focused = true;
      editor.render(80);
      await extension.handlers.get("session_shutdown")[0]({ type: "session_shutdown" }, context);
      assert.equal(showHardwareCursor, initialHardwareCursor);
      assert.equal(terminalWrites.at(-1), initialHardwareCursor ? "\x1b[0 q" : undefined);
    });
  }

  await t.test("cursor follows hardware setting changes on the existing editor", async () => {
    await extension.commands.get("vi").handler("on", context);
    editor.focused = true;
    editor.setText("draft");
    showHardwareCursor = true;
    terminalWrites.length = 0;
    editor.render(80);
    assert.deepEqual(terminalWrites, ["\x1b[6 q"]);

    showHardwareCursor = false;
    const softwareLines = editor.render(80);
    assert.equal(showHardwareCursor, false);
    assert.equal(terminalWrites.at(-1), "\x1b[0 q");
    assert.ok(softwareLines.some((line) => line.includes("\x1b[4m")));
    const writes = terminalWrites.length;
    editor.render(80);
    assert.equal(terminalWrites.length, writes);

    showHardwareCursor = true;
    editor.render(80);
    assert.equal(terminalWrites.at(-1), "\x1b[6 q");
    await extension.commands.get("vi").handler("off", context);
    assert.equal(showHardwareCursor, true);
    assert.equal(terminalWrites.at(-1), "\x1b[0 q");
  });

  await t.test("working status renders in the top border without displacing vi indicators", async (st) => {
    // Arrange
    await extension.commands.get("vi").handler("on", context);
    const current = editor;
    current.setText("draft");
    const working = new StatusIndicator("working", { requestRender() {} }, identity, identity, "Working");
    st.after(() => working.dispose());

    // Act
    current.setWorkingStatusIndicator(working);
    const insertLines = current.render(80);
    current.handleInput("\x1b");
    const normalLines = current.render(80);
    current.setWorkingStatusIndicator(undefined);
    const idleLines = current.render(80);

    // Assert
    assert.match(insertLines[0], /Working/);
    assert.match(normalLines[0], /Working/);
    assert.match(insertLines[1], /❯.*draft/);
    assert.match(normalLines[1], /❮.*draft/);
    assert.ok(idleLines.every((line) => !line.includes("Working")));
    assert.equal(current.embedWorkingStatus, true, "Pi must recognize support for embedded status");
    assert.equal(current.getText(), "draft");
  });

  for (const key of ["o", "O"]) {
    for (const { text, line, label } of [
      { text: "", line: 0, label: "empty input" },
      { text: "draft", line: 0, label: "single line" },
      { text: "first\nmiddle\nlast", line: 0, label: "first line" },
      { text: "first\nmiddle\nlast", line: 1, label: "middle line" },
      { text: "first\nmiddle\nlast", line: 2, label: "last line" },
    ]) {
      await t.test(`${key} opens a line without submitting: ${label}`, async () => {
        // Arrange
        await extension.commands.get("vi").handler("on", context);
        editor.setText(text);
        editor.handleInput("\x1b");
        editor.handleInput("g");
        editor.handleInput("g");
        for (let i = 0; i < line; i++) editor.handleInput("j");
        editor.handleInput("l");
        const submissions = [];
        editor.onSubmit = (value) => submissions.push(value);
        const insertionLine = line + (key === "o" ? 1 : 0);
        const expectedLines = text.split("\n");
        expectedLines.splice(insertionLine, 0, "");

        // Act
        editor.handleInput(key);

        // Assert
        assert.deepEqual(submissions, [], "opening a line must not submit the draft");
        assert.equal(editor.getText(), expectedLines.join("\n"));
        assert.deepEqual(editor.getCursor(), { line: insertionLine, col: 0 });
        assert.equal(editor.getMode(), "insert");
        editor.handleInput("new");
        expectedLines[insertionLine] = "new";
        assert.equal(editor.getText(), expectedLines.join("\n"));
        assert.deepEqual(submissions, []);
      });
    }
  }

  await t.test("vi horizontal motions follow rebound Pi actions", async () => {
    // Arrange
    const previousKeybindings = getKeybindings();
    editorKeybindings = new KeybindingsManager();
    editorKeybindings.setUserBindings({
      "tui.editor.cursorLeft": "alt+h",
      "tui.editor.cursorRight": "alt+l",
    });
    setKeybindings(editorKeybindings);
    try {
      await extension.commands.get("vi").handler("on", context);
      editor.setText("abcd");
      editor.handleInput("\x1b");
      editor.handleInput("0");

      // Act
      for (const key of "3lh") editor.handleInput(key);

      // Assert
      assert.equal(editor.getText(), "abcd");
      assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
    } finally {
      setKeybindings(previousKeybindings);
      editorKeybindings = new KeybindingsManager();
    }
  });

  async function editorWithBindings(st, bindings) {
    const previousKeybindings = getKeybindings();
    editorKeybindings = new KeybindingsManager();
    editorKeybindings.setUserBindings(bindings);
    setKeybindings(editorKeybindings);
    st.after(() => {
      setKeybindings(previousKeybindings);
      editorKeybindings = new KeybindingsManager();
    });
    await extension.commands.get("vi").handler("on", context);
    return editor;
  }

  const disabledBindings = Object.fromEntries(
    Object.keys(new KeybindingsManager().getResolvedBindings()).map((action) => [action, []]),
  );
  const shortcutKeys = [
    "right", "ctrl+right", "alt+right", "super+left", "shift+home", "ctrl+end",
    "a", "shift+a", "ctrl+x", "alt+l", "super+k", "ctrl+shift+alt+super+p",
    "ctrl++", "shift+!", "ctrl+shift+?", "escape", "esc", "enter", "return",
    "tab", "space", "backspace", "shift+enter", "alt+enter", "super+space",
    "delete", "ctrl+insert", "pageUp", "super+pageDown", "clear", "shift+clear",
    "ctrl+clear", ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
    "super+f12", "ctrl+shift+f5",
  ];
  for (const kitty of [false, true]) {
    for (const key of shortcutKeys) {
      await t.test(`vi resolves ${key} with Kitty ${kitty ? "on" : "off"}`, async (st) => {
        // Arrange
        const previousKitty = isKittyProtocolActive();
        setKittyProtocolActive(kitty);
        st.after(() => setKittyProtocolActive(previousKitty));
        const current = await editorWithBindings(st, {
          ...disabledBindings,
          "tui.editor.cursorLineStart": "ctrl+a",
          "tui.editor.cursorRight": key,
        });
        current.setText("abcd");
        for (const input of ["\x1b", "0"]) current.handleInput(input);
        const submissions = [];
        current.onSubmit = (text) => submissions.push(text);

        // Act
        current.handleInput("l");

        // Assert
        assert.deepEqual(current.getCursor(), { line: 0, col: 1 });
        assert.equal(current.getText(), "abcd");
        assert.deepEqual(submissions, []);
      });
    }
  }

  for (const intercept of ["application", "extension"]) {
    await t.test(`internal movement does not trigger a matching ${intercept} shortcut`, async (st) => {
      // Arrange
      const current = await editorWithBindings(st, { "tui.editor.cursorRight": "ctrl+l" });
      current.setText("abcd");
      for (const input of ["\x1b", "0"]) current.handleInput(input);
      const actions = [];
      if (intercept === "application") current.onAction("app.model.select", () => actions.push("model"));
      else current.onExtensionShortcut = (data) => {
        if (!editorKeybindings.matches(data, "app.model.select")) return false;
        actions.push("extension");
        return true;
      };

      // Act
      current.handleInput("l");

      // Assert
      assert.deepEqual(actions, []);
      assert.deepEqual(current.getCursor(), { line: 0, col: 1 });
    });
  }

  const regressions = [
    {
      name: "operator and motion counts multiply",
      text: "one two three four five six seven eight nine",
      keys: [..."2d3w"], expected: "seven eight nine",
    },
    {
      name: "counts multiply for doubled operators",
      text: "1\n2\n3\n4\n5\n6\n7\n8",
      keys: [..."2d3d"], expected: "7\n8",
    },
    {
      name: "word-end motion honors its count",
      text: "one two three four",
      keys: [..."3e", "i", "X", "\x1b"], expected: "one two threXe four",
    },
    {
      name: "dot repeats the most recent horizontal operator edit",
      text: "abcdef",
      keys: [..."rXldl."], expected: "Xdef",
    },
    {
      name: "dot repeats an operator with a find motion",
      text: "abxcdyefxgh",
      keys: [..."rQldfx."], expected: "Qgh",
    },
    {
      name: "yanking does not replace the last change",
      text: "one two three",
      keys: [..."xyw."], expected: "e two three",
    },
    {
      name: "an unchanged insert session does not replace the last change",
      text: "abcdef",
      keys: [..."rXli", "\x1b", "."], expected: "XXcdef",
    },
    {
      name: "a no-op deletion does not replace the last change",
      text: "abcdef",
      keys: [..."rXGx0l."], expected: "XXcdef",
    },
    {
      name: "dot replays a complete change and inserted text",
      text: "one two three",
      keys: [..."cw", "new ", "\x1b", "."], expected: "new new three",
    },
    {
      name: "multidigit counts stay separate across the operator",
      text: Array.from({ length: 24 }, (_, i) => `w${i + 1}`).join(" "),
      keys: [..."10d2w"], expected: "w21 w22 w23 w24",
    },
    {
      name: "zero remains a line-start motion after an operator count",
      text: "abcdef", keys: [..."ll2d0"], expected: "cdef",
    },
    {
      name: "counted dot overrides rather than multiplies the previous count",
      text: "one two three four five six seven eight nine",
      keys: [..."2dw3."], expected: "six seven eight nine",
    },
    {
      name: "plain dot retains the count selected by counted dot",
      text: "one two three four five six seven eight nine",
      keys: [..."2dw3.."], expected: "nine",
    },
    {
      name: "counted dot replaces both sides of an operator count",
      text: Array.from({ length: 12 }, (_, i) => `w${i + 1}`).join(" "),
      keys: [..."2d3w2."], expected: "w9 w10 w11 w12",
    },
    {
      name: "counted dot preserves the zero motion in a deletion",
      text: "abcdef", keys: [..."lld0ll2."], expected: "ef",
    },
    {
      name: "counted dot preserves the zero motion in a change",
      text: "abcdef",
      keys: [..."llc0", "Q", "\x1b", ..."ll2."], expected: "Qef",
    },
    {
      name: "counted line-end motion reaches the requested line",
      text: "one\ntwo\nthree",
      keys: [..."2$", "i", "X", "\x1b"], expected: "one\ntwoX\nthree",
    },
    {
      name: "counted line-end operator spans the requested lines",
      text: "one\ntwo\nthree", keys: [..."d2$"], expected: "\nthree",
    },
    {
      name: "counted Y yanks the requested lines",
      text: "1\n2\n3\n4", keys: [..."3YGp"], expected: "1\n2\n3\n4\n1\n2\n3",
    },
    {
      name: "counted D deletes through the requested line end",
      text: "one\ntwo\nthree", keys: [..."2D"], expected: "\nthree",
    },
    {
      name: "counted C changes the range but inserts replacement text once",
      text: "one\ntwo\nthree",
      keys: [..."2C", "new", "\x1b"], expected: "new\nthree",
    },
    {
      name: "counted S substitutes the requested lines",
      text: "one\ntwo\nthree",
      keys: [..."2S", "new", "\x1b"], expected: "new\nthree",
    },
    {
      name: "counted G addresses a line rather than the buffer end",
      text: "one\ntwo\nthree\nfour",
      keys: [..."3G", "i", "X", "\x1b"], expected: "one\ntwo\nXthree\nfour",
    },
    {
      name: "counted gg addresses a line rather than the buffer start",
      text: "one\ntwo\nthree\nfour",
      keys: [..."2gg", "i", "X", "\x1b"], expected: "one\nXtwo\nthree\nfour",
    },
    {
      name: "counted insert repeats the inserted text",
      text: "tail", keys: [..."3i", "x", "\x1b"], expected: "xxxtail",
    },
    {
      name: "counted append repeats the inserted text",
      text: "tail", keys: [..."3a", "x", "\x1b"], expected: "txxxail",
    },
    {
      name: "counted line-start insert repeats the inserted text",
      text: "tail", keys: [..."2I", "x", "\x1b"], expected: "xxtail",
    },
    {
      name: "counted line-end append repeats the inserted text",
      text: "tail", keys: [..."2A", "x", "\x1b"], expected: "tailxx",
    },
    {
      name: "counted open below inserts the requested lines without submitting",
      text: "head", keys: [..."3o", "new", "\x1b"], expected: "head\nnew\nnew\nnew",
    },
    {
      name: "counted open above inserts the requested lines without submitting",
      text: "head", keys: [..."3O", "new", "\x1b"], expected: "new\nnew\nnew\nhead",
    },
    {
      name: "counted inner-word object spans words",
      text: "one two three", keys: [..."2diw"], expected: " three",
    },
    {
      name: "counted around-word object spans words and trailing whitespace",
      text: "one two three", keys: [..."d2aw"], expected: "three",
    },
    {
      name: "counted change object inserts its replacement once",
      text: "one two three",
      keys: [..."2ciw", "new", "\x1b"], expected: "new three",
    },
    {
      name: "counted bracket object selects an enclosing pair",
      text: "(outer (inner) tail)", keys: [..."f(l2di("], expected: "()",
    },
    {
      name: "counted find operators multiply counts",
      text: "a1x2x3x4x5x6xtail", keys: [..."2d3fx"], expected: "tail",
    },
    {
      name: "dot repeats a backward horizontal operator",
      text: "abcdef", keys: [..."rXllldh."], expected: "Xdef",
    },
    {
      name: "dot repeats a line-start operator",
      text: "abcdef", keys: [..."rXlld0ll."], expected: "ef",
    },
    {
      name: "dot repeats a line-end operator",
      text: "abcdef\nsecond", keys: [..."rXld$j0l."], expected: "X\ns",
    },
    {
      name: "dot records replacement text after a find-motion change",
      text: "abxcdyefxgh",
      keys: [..."lcfx", "Q", "\x1b", "."], expected: "aQQgh",
    },
    {
      name: "a failed change object does not replace the last edit",
      text: "abcdef", keys: [..."rXlci\"."], expected: "XXcdef",
    },
    {
      name: "undo preserves the last repeatable edit",
      text: "abcdef", keys: [..."xu."], expected: "bcdef",
    },
    {
      name: "Pi undo shortcut preserves the last repeatable edit",
      text: "abcdef", keys: ["x", "\x1f", "."], expected: "bcdef",
    },
    {
      name: "find repeat is recorded independently of later searches",
      text: "abcxdefxghyzxlast",
      keys: [..."fxld;fy0."], expected: "ghyzxlast",
    },
    {
      name: "counted dot overrides counted insertion",
      text: "tail", keys: [..."2i", "X", "\x1b", ..."3."], expected: "XXXXXtail",
    },
    {
      name: "escape abandons an operator without contaminating the next change",
      text: "abcdef", keys: [..."2d", "\x1b", "x", "."], expected: "cdef",
    },
  ];
  const reboundBindings = {
    "tui.editor.cursorLeft": "alt+h",
    "tui.editor.cursorRight": "alt+l",
    "tui.editor.cursorUp": "alt+k",
    "tui.editor.cursorDown": "alt+j",
    "tui.editor.cursorLineStart": "alt+0",
    "tui.editor.cursorLineEnd": "alt+$",
    "tui.editor.cursorWordLeft": "alt+b",
    "tui.editor.cursorWordRight": "alt+w",
    "tui.editor.undo": "alt+z",
  };
  for (const [label, bindings] of [["default", {}], ["rebound", reboundBindings]]) {
    for (const { name, text, keys, expected } of regressions) {
      await t.test(`${label}: ${name}`, async (st) => {
        // Arrange
        const current = await editorWithBindings(st, bindings);
        current.setText(text);
        for (const key of ["\x1b", "g", "g"]) current.handleInput(key);
        const submissions = [];
        current.onSubmit = (value) => submissions.push(value);

        // Act
        for (const key of keys) current.handleInput(label === "rebound" && key === "\x1f" ? "\x1bz" : key);

        // Assert
        assert.equal(current.getText(), expected);
        assert.deepEqual(submissions, []);
        assert.equal(current.getMode(), "normal");
      });
    }
  }

  for (const { keys, cursor } of [
    { keys: "2jk", cursor: { line: 1, col: 0 } },
    { keys: "2wb", cursor: { line: 0, col: 4 } },
    { keys: "2l0", cursor: { line: 0, col: 0 } },
    { keys: "$", cursor: { line: 0, col: 7 } },
    { keys: "fx", cursor: { line: 0, col: 4 } },
  ]) {
    await t.test(`rebound navigation: ${keys}`, async (st) => {
      // Arrange
      const current = await editorWithBindings(st, reboundBindings);
      current.setText("one xxz\nsecond\nthird");
      for (const key of ["\x1b", "g", "g"]) current.handleInput(key);

      // Act
      for (const key of keys) current.handleInput(key);

      // Assert
      assert.deepEqual(current.getCursor(), cursor);
    });
  }

  await t.test("vi uses a later usable configured shortcut", async (st) => {
    // Arrange
    const current = await editorWithBindings(st, {
      "tui.editor.cursorRight": ["ctrl+escape", "alt+l"],
    });
    current.setText("abcd");
    for (const key of ["\x1b", "0"]) current.handleInput(key);

    // Act
    current.handleInput("l");

    // Assert
    assert.deepEqual(current.getCursor(), { line: 0, col: 1 });
  });

  await t.test("disabled movement and undo do not fall back to default keys", async (st) => {
    // Arrange
    const current = await editorWithBindings(st, {
      "tui.editor.cursorRight": [], "tui.editor.undo": [],
      "tui.editor.deleteToLineEnd": "right",
    });
    current.setText("abcd");
    for (const key of ["\x1b", "0", "x"]) current.handleInput(key);

    // Act
    for (const key of "lu") current.handleInput(key);

    // Assert
    assert.equal(current.getText(), "bcd");
    assert.deepEqual(current.getCursor(), { line: 0, col: 0 });
  });

  await t.test("binding changes apply to an existing vi editor and insert input", async (st) => {
    // Arrange
    const current = await editorWithBindings(st, { "tui.editor.cursorRight": "alt+l" });
    current.setText("abcd");
    for (const key of ["\x1b", "0", "l"]) current.handleInput(key);
    editorKeybindings.setUserBindings({ "tui.editor.cursorRight": "alt+q" });

    // Act
    for (const key of ["l", "i", "\x1bq", "X", "\x1b"]) current.handleInput(key);

    // Assert
    assert.equal(current.getText(), "abcXd");
  });

  for (const { name, text, keys, expected } of [
    {
      name: "counted insertion stops recording on submission", text: "tail",
      keys: ["\x1b", "g", "g", ..."3i", "X", "\r", "\x1b", "."], expected: "Xtail",
    },
    {
      name: "normal-mode submission does not replace dot", text: "tail",
      keys: ["\x1b", "g", "g", "x", "\r", "."], expected: "ail",
    },
  ]) {
    await t.test(name, async () => {
      // Arrange
      await extension.commands.get("vi").handler("on", context);
      const current = editor;
      current.setText(text);
      const submissions = [];
      current.onSubmit = (value) => submissions.push(value);

      // Act
      for (const key of keys) current.handleInput(key);

      // Assert
      assert.deepEqual(submissions, [expected]);
      assert.equal(current.getText(), "");
      assert.equal(current.getMode(), "normal");
    });
  }

  await t.test("dot never replays a submitted prompt", async () => {
    // Arrange
    await extension.commands.get("vi").handler("on", context);
    const current = editor;
    const submissions = [];
    current.onSubmit = (value) => submissions.push(value);

    // Act
    current.handleInput("draft");
    current.handleInput("\r");
    current.handleInput("next");
    current.handleInput("\x1b");
    current.handleInput(".");

    // Assert
    assert.deepEqual(submissions, ["draft"]);
    assert.equal(current.getText(), "nextnext");
  });

  await t.test("clipboard copies are nonblocking, serialized, and latest-wins", async () => {
    // Arrange
    await new Promise(setImmediate);
    clipboardCopies.length = 0;
    let release;
    clipboardGate = new Promise((resolve) => { release = resolve; });
    await extension.commands.get("vi").handler("on", context);
    const current = editor;
    current.setText("one\ntwo\nthree");
    for (const key of ["\x1b", "g", "g"]) current.handleInput(key);

    // Act
    for (const key of "yy") current.handleInput(key);
    await new Promise(setImmediate);
    for (const key of "jyyjyy") current.handleInput(key);
    current.handleInput("p");

    // Assert
    try {
      assert.deepEqual(clipboardCopies, ["one\n"], "one active copy; later writes remain queued");
      assert.equal(current.getText(), "one\ntwo\nthree\nthree", "paste uses the register without waiting for clipboard I/O");
    } finally {
      clipboardGate = undefined;
      release();
      await new Promise(setImmediate);
    }
    assert.deepEqual(clipboardCopies, ["one\n", "three"], "superseded pending writes are dropped");
  });

  await t.test("clipboard failure warns once, preserves the register, and recovers", async () => {
    // Arrange
    await new Promise(setImmediate);
    clipboardCopies.length = 0;
    failClipboard = true;
    await extension.commands.get("vi").handler("on", context);
    const current = editor;
    current.setText("one\ntwo");
    for (const key of ["\x1b", "g", "g"]) current.handleInput(key);
    const copyWarnings = () => notifications.filter(([message]) => message.includes("Clipboard copy failed"));

    // Act
    for (const key of "yy") current.handleInput(key);
    await new Promise(setImmediate);
    for (const key of "jyy") current.handleInput(key);
    await new Promise(setImmediate);
    current.handleInput("p");

    // Assert
    try {
      assert.equal(current.getText(), "one\ntwo\ntwo");
      assert.equal(copyWarnings().length, 1);
      assert.equal(copyWarnings()[0][1], "warning");
    } finally {
      failClipboard = false;
    }
    for (const key of "yy") current.handleInput(key);
    await new Promise(setImmediate);
    assert.equal(clipboardCopies.at(-1), "two", "copying resumes after a failure");
    assert.equal(copyWarnings().length, 1);
  });

  await t.test("default clipboard backend emits OSC52 through Pi", {
    skip: process.platform !== "linux" || /microsoft/i.test(release()),
  }, async (st) => {
    // Arrange
    const environmentKeys = ["DISPLAY", "WAYLAND_DISPLAY", "TERMUX_VERSION", "PI_CLIPBOARD_OSC52"];
    const environment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    for (const key of environmentKeys) delete process.env[key];
    const sequences = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    st.mock.method(process.stdout, "write", (chunk, ...args) => {
      const text = chunk.toString();
      if (text.startsWith("\x1b]52;c;")) {
        sequences.push(text);
        return true;
      }
      return originalWrite(chunk, ...args);
    });

    try {
      // Act
      await result.extensions[0].handlers.get("session_start")[0]({ type: "session_start" }, context);
      editor.setText("pi-vi clipboard test");
      for (const key of ["\x1b", "g", "g", "y", "y"]) editor.handleInput(key);
      await new Promise(setImmediate);

      // Assert
      assert.deepEqual(sequences, [`\x1b]52;c;${Buffer.from("pi-vi clipboard test").toString("base64")}\x07`]);
    } finally {
      st.mock.restoreAll();
      for (const [key, value] of environment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  const command = extension.commands.get("vi");
  await command.handler("clipboard on", context);
  assert.match(notifications.at(-1)[0], /clipboard enabled/);
  await command.handler("clipboard off", context);
  assert.match(notifications.at(-1)[0], /clipboard disabled/);
  await command.handler("off", context);
  assert.equal(factory, undefined);
  assert.equal(statuses.get("vi-mode"), undefined);
  await command.handler("on", context);
  assert.equal(editor.getMode(), "insert");
  await extension.shortcuts.get("ctrl+shift+v").handler(context);
  assert.equal(factory, undefined);

  const host = JSON.parse(await readFile(path.join(hostDir, "package.json"), "utf8"));
  t.diagnostic(`Verified with ${host.name}@${host.version} from ${hostDir}`);
});
