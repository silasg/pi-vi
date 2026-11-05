# ADR-0001: Delegate clipboard writes to Pi

## Status

Proposed record for review. The user approved the backend choice and internal-register paste policy in conversation.

## Context

The extension's synchronous clipboard writers can block editing and target the sandbox's clipboard rather than the host's. Pi 1.5.0 exports an asynchronous `copyToClipboard()` helper with native/Wayland support, command timeouts, and OSC52 output for remote or headless terminals.

## Decision Drivers

1. Yanks and deletes must update the internal register without waiting for clipboard I/O.
2. Rapid edits must not create concurrent clipboard writes or an unbounded backlog of obsolete values.
3. Sandbox-to-host copying should work through an existing terminal route without requiring a custom host listener.
4. Default `p/P` behavior and line-wise register metadata must remain unchanged.

## Considered Alternatives

### Alternative 1: Reuse Pi's clipboard helper

Delegate platform detection and OSC52 emission to the host-provided API; serialize writes and retain only the latest pending value. Availability and backend behavior depend on the Pi version.

### Alternative 2: Maintain extension-owned clipboard commands

Adding asynchronous commands and OSC52 locally would duplicate host functionality and require separate platform maintenance.

### Alternative 3: Require a custom sandbox-host bridge

A bridge could provide explicit host access, but requires host installation, access controls, and its own protocol. It is not required for terminal-based copying and is outside the approved scope.

## Decision

Use Pi's exported helper for asynchronous writes. Allow one active write and replace any pending value with the latest yank/delete. Catch copy failures, warn once per extension load, and keep the internal register available. Keep default `p/P` internal; host-to-Pi text enters through ordinary terminal paste in insert mode. Retain the existing opt-in local clipboard reader without adding a host text-read bridge.

## Consequences

### Positive

Editing and internal paste do not wait for copy completion. Platform writers and terminal OSC52 handling come from Pi rather than duplicated extension code.

### Negative

OSC52 output cannot confirm the host clipboard changed; terminal/multiplexer permissions and size limits still apply. An in-flight write cannot be cancelled through this API. The retained opt-in reader remains synchronous and cannot read a host clipboard merely because Pi runs in a sandbox.

### Neutral

Intermediate pending clipboard values can be skipped. No packages, host services, or persistent clipboard settings are added.

## Reversibility

Replace the injected copy function and queue policy in the extension entry point; register and paste behavior are independent. A custom bridge would require a separate decision.

## Related ADRs

None.
