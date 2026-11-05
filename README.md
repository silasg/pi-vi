# pi-vi

Vim-style modal editing for the Pi coding agent: https://github.com/earendil-works/pi.
This replaces Pi's prompt editor; it is not a full Vim implementation.

## Installation

```sh
pi install git:github.com/silasg/pi-vi@main
```

Run `/reload` or restart Pi after installation. Add `--local` for project-scoped
installation. Install as the user who runs Pi, not as root.

Remove any old copied `vi-mode.ts` from Pi's extension directories and explicit
extension paths first; do not load both copies.

Update or uninstall:

```sh
pi update git:github.com/silasg/pi-vi@main
pi remove git:github.com/silasg/pi-vi@main
```

Use `--local` for project installations, then `/reload` or restart Pi.
Uninstalling the package does not remove legacy copied extensions.

Repository: https://github.com/silasg/pi-vi

## Modes and commands

The extension starts enabled in **insert mode** for each session. Insert mode
passes input to Pi's normal editor. **Normal mode** interprets the keys below;
unrecognized printable characters are ignored, while other input is forwarded
to Pi. Enter can still submit a prompt in normal mode.

| # | Key or command | Action |
|---|---|---|
| 1 | `Esc` in insert mode | Enter normal mode |
| 2 | `Esc` in normal mode | Forward to Pi (for example, interrupt) |
| 3 | `/vi` | Toggle the custom editor |
| 4 | `/vi on`, `/vi off` | Enable or disable the custom editor |
| 5 | `Ctrl+Shift+V` | Toggle the custom editor, if the terminal sends this key |
| 6 | `/vi clipboard on`, `/vi clipboard off` | Enable/disable OS clipboard reads for `p`/`P`; off by default |

The footer shows `vi [INSERT]` or `vi [NORMAL]`. The first editor line has a
green `❯` or yellow `❮` indicator.
Insert mode uses a vertical terminal cursor, like Neovim. Normal mode uses a block cursor.
Pending counts and operators appear in the bottom border.

The extension enables the hardware cursor while the editor has focus, regardless of `showHardwareCursor`.
It restores Pi's hardware-cursor setting and the terminal's default cursor shape when focus leaves the editor, vi mode is disabled, or the session ends.
The terminal must support DECSCUSR cursor shapes.
Use `editorPaddingX > 0` for the mode indicator. Restart after changing this setting.

## Normal-mode keys

| # | Keys | Implemented behavior |
|---|---|---|
| 1 | `h`, `j`, `k`, `l` | Delegate left, down, up, right movement to Pi |
| 2 | `0`, `$` | Start/end of current line; `2$` reaches the next line's end |
| 3 | `w`, `b` | Pi's word-right/word-left movement, not exact Vim word semantics |
| 4 | `e` | End of a whitespace-delimited word |
| 5 | `W`, `B`, `E` | Whitespace-delimited WORD motions |
| 6 | `gg`, `G` | Start/end of the entire input buffer; `3gg`/`3G` go to line 3 |
| 7 | `f{char}`, `F{char}`, `t{char}`, `T{char}` | Find/till character forward/backward on the current line |
| 8 | `;`, `,` | Repeat/reverse the last find motion |
| 9 | `i`, `a`, `I`, `A` | Insert at cursor, after cursor, line start, line end |
| 10 | `d`, `c`, `y` + motion | Delete, change (then insert), or yank a range |
| 11 | `dd`, `cc`, `yy` | Line-wise delete/change/yank |
| 12 | `dj`, `dk`, `cj`, `ck`, `yj`, `yk` | Line-wise operation including adjacent lines |
| 13 | `Y` | Yank current line, or multiple lines with a count |
| 14 | `x`, `X` | Delete at/before cursor |
| 15 | `r{char}`, `s`, `S` | Replace character(s), substitute character(s), substitute line |
| 16 | `D`, `C` | Delete/change to line end; counts extend through later lines |
| 17 | `p`, `P` | Paste after/before cursor; line-wise registers paste below/above |
| 18 | `u` | Delegate undo using Pi's configured undo shortcut |
| 19 | `.` | Replay the last successful edit, including inserted text; a count overrides its original count |
| 20 | `o`, `O` | Open a blank line below/above the current line and enter insert mode without submitting |

Operators support `h/j/k/l`, `0/$`, word motions, find motions, and the following
text objects with `i` (inner) or `a` (around):

| # | Objects | Examples |
|---|---|---|
| 1 | Whitespace-delimited word: `iw`, `aw` | `diw`, `caw` |
| 2 | Quotes: `"`, `'`, backtick | `di"`, `ya'` |
| 3 | Paired delimiters: `()`, `[]`, `{}`, `<>` (either delimiter accepted) | `ci(`, `da]` |

1. Operator and motion counts multiply: `2d3w` deletes six whitespace-delimited
   words, and `2d3d` deletes six lines. A zero with no motion count remains the
   line-start motion (`2d0`); digits within each count remain multidigit numbers.
2. Counts apply to movement, find motions, replacement/deletion, paste, undo,
   line-wise yanks, and `D`/`C`/`S`. `3e` advances to the third word's end;
   `3Y` yanks three lines. Counted `gg`/`G` address a line number.
3. Counted `i`/`a`/`I`/`A` repeat the insert input on `Esc`; counted `o`/`O`
   repeat it on separate new lines. Change commands such as `2cw` apply the
   count to the changed range and insert the replacement text once.
4. Counted word objects span words; counted bracket objects select enclosing
   pairs. Quote objects select one pair regardless of count. Parsing remains
   simple and is not intended to implement every Vim text-object rule.
5. Plain `.` retains the last edit's count. An explicit count replaces it:
   after `2dw`, `3.` deletes three words, not six. Yanks, movement, undo, failed
   operations, and edits with no final text change do not replace the last edit.
   Find-repeat edits capture the resolved target/direction for later replay.

## Clipboard

### Copying out

Yanks and deletes update the internal register immediately and copy asynchronously
using Pi's `copyToClipboard()` helper. Editing never waits for clipboard I/O;
only one copy runs at a time, with the latest pending value retained. Copying
is always enabled. Failures warn once per extension load without breaking
internal paste or subsequent copies.

Pi supplies platform backends, timeouts, and OSC52 for remote/headless terminals.
OSC52 can reach the host clipboard from a sandbox or SSH session, subject to
terminal/multiplexer permissions and size limits. Silent terminal rejection
cannot be detected. Pi 1.5.0 supports `PI_CLIPBOARD_OSC52=1` to force this route;
no custom host listener is needed.

### Pasting in

`p`/`P` use the internal register, preserving line-wise metadata. To paste from
another host application, use your terminal's paste action in insert mode.

`/vi clipboard on` makes `p`/`P` prefer a non-empty **local/sandbox** clipboard.
Empty or failed reads fall back to the register; clipboard text is character-wise.
`/vi clipboard off` restores internal-only paste. Neither the option nor the
register persists across sessions.

The opt-in reader uses these local tools:

| # | Platform | Local reader prerequisites |
|---|---|---|
| 1 | macOS | `pbpaste` |
| 2 | Linux | `xclip`, otherwise `xsel`, plus a working X clipboard/display |
| 3 | Windows | `powershell.exe` (`Get-Clipboard`) |

It has no native Wayland or host text-read bridge support. Its subprocesses
remain synchronous without explicit timeouts; enabling this reader can still
stall editing if a helper stalls. Leave it off in a sandbox unless you explicitly
need that sandbox's local clipboard.

## Shortcut conflicts and limitations

1. `Ctrl+Shift+V` is commonly intercepted as terminal paste. Use `/vi` if your
   terminal does not deliver it. Pi 1.5.0's default image-paste shortcut is
   `Ctrl+V` (`Alt+V` on Windows/WSL), which is separate from this toggle.
2. The extension replaces other custom editors instead of composing with them.
   Disabling restores Pi's default editor, not another extension's editor.
3. The first insert-mode `Esc` switches modes rather than reaching Pi's interrupt
   handling. In normal mode, `Esc` is forwarded to Pi.
4. Movement and undo resolve Pi's configured shortcuts. Internal motions bypass
   application and extension shortcuts, but conflicting editor-action bindings
   still follow Pi's precedence; use unambiguous editor bindings. Actions disabled
   with `[]` have no fallback: their delegated vi motions/undo do nothing, and
   edits requiring those motions for positioning are unsupported. Normal-mode
   printable keys consumed here do not reach Pi; unhandled control sequences do.
5. This is a subset, not Vim emulation: no visual mode, named registers, macros,
   `/` search, redo command, or full Ex command language. `/vi` is a Pi command.
6. Text-object parsing is simple, not language-aware, and quote-object counts
   select just one pair. Operator word ranges are whitespace-based, while plain
   `w`/`b` use Pi's word boundaries. With tested Pi defaults, `w` from column 0
   in `hello world` lands at column 5, not 6.
7. Dot-repeat replays key input, not an editor snapshot; Pi keybindings still
   apply, and paste uses the current register/clipboard policy. Undo grouping
   follows Pi and may not match Vim transactions.
8. Editor layout, Unicode, wrapped-line behavior, and terminal key delivery need
   real-terminal testing; headless smoke checks do not establish full fidelity.

## Development and verification

Use regression-first TDD for behavior fixes. Validate documentation and packaging
changes with package checks and appropriate load/manual smoke tests. Architecture
decisions are recorded in `docs/adr/`.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run
```

Headless tests use Pi's real loader and editor. They cover editing, counts,
dot-repeat, default/rebound bindings, clipboard queueing/failures, and toggling.
Clipboard I/O is isolated, and no model requests are sent. These checks do not
replace real-terminal testing.

To test against an existing Pi installation:

```sh
PI_TEST_HOST_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" npm test
```

Adjust the path if Pi was installed differently. Manual checks in a disposable session:

1. Load only this package, confirm indicators/cursor, toggle with `/vi` and the
   shortcut, and check interrupt/submit behavior with a harmless draft.
2. Exercise counts, find motions, text objects, multiline line-wise paste, undo,
   and dot-repeat, including wrapped lines and Unicode. Repeat with nondefault
   `tui.editor.cursor*` and `tui.editor.undo` bindings after `/reload`.
3. Test yank-to-another-app on your actual terminal/sandbox and terminal paste
   back into insert mode. If you need the optional local reader, test it separately
   with reads both off and on, including fallback when local access is unavailable.
4. Clean-install in a fresh Pi configuration; check `pi list`, `/reload`, update,
   and removal.

## License and provenance

MIT — see `LICENSE`. The extension was extracted from Silas Graffy's
`pi-coding-agent-extensions` repository, whose package metadata declares MIT.
No third-party attribution or copyright notices were found in the inspected
extension or its local source lineage. That inspection is not proof of complete
upstream provenance; retain any applicable third-party notices if additional
borrowed code is identified.
