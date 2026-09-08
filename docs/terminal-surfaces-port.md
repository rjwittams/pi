# Terminal surfaces on current upstream

Exploration baseline: upstream `c1d4c8011` (package version 0.85.1).
Previous implementation: `dad9e51cb`, based on `20b78eaf` (0.79.0).
Worktree: `/Users/robert/dev/pi-terminal-surfaces`, branch `terminal-surfaces-upstream`.

## Scope

Pi should let extensions attach interactive, externally drawn content to ordinary TUI components and overlays. Katzensteg is a consumer that exercises the requirements. Pi must not depend on its executable, producer protocol, profiles, process management, frame batches, environment variables, or window policies.

The extension owns its content, image encoding, processes, and application input translation. Pi owns placement in its layout, clipping information, terminal output ordering, focus, mouse routing, and the lifetime of registrations it creates.

This document preserves the initial source exploration and port proposal. The implementation now lives in this branch; see [the surface API](terminal-surface-geometry.md) and [runnable examples](terminal-surface-examples.md) for current behavior. The findings and validation below describe the original exploration baseline.

## Existing upstream support

| Requirement | Current upstream | Port direction |
| --- | --- | --- |
| Overlay positioning and focus | `TuiBase.showOverlay`, shared by both renderers; `OverlayHandle.getBounds()` | Extend existing handles and layout; preserve overlay focus rules |
| Mouse input | `Component.handleMouse(TuiMouseEvent)`; fullscreen dispatch and capture | Reuse this event model; provide corresponding regular-mode routing |
| Fullscreen geometry | `LayoutBox.rect` and `clip`, nested stacks and scroll views | Publish committed geometry through a small generic surface interface |
| Ordinary nested components | `Container` and `Box` retain private mouse layouts | Add a shared way to report rendered child geometry |
| External drawing | Public `terminal.write`, but no `writeRaw`, post-render callback, or invalidation contract | Provide an ordered, cursor-safe drawing path |
| Inline custom messages | Renderer factory returns a component; no surface handle/TUI in `MessageRenderOptions` | Add generic attachment and cleanup at this host seam |
| Renderer changes | `createInteractiveTuiReference` forwards calls to the current renderer | Explicitly handle persistent registrations and old renderer handles |

Relevant implementation files:

- `packages/tui/src/tui.ts`: shared interface, container, overlay composition and focus.
- `packages/tui/src/tui-main-screen.ts`: regular-mode differential writes and cursor/viewport state.
- `packages/tui/src/tui-alt-screen.ts`: fullscreen frame commit, mouse gestures, image cache and deletion.
- `packages/tui/src/layout.ts` and `layout-node.ts`: logical rectangles, clipping, layout traversal.
- `packages/tui/src/components/box.ts` and `mouse-region.ts`: nested component adapters.
- `packages/coding-agent/src/modes/interactive/components/custom-message.ts`: renderer rebuild/lifetime.
- `packages/coding-agent/src/modes/interactive/tui-renderer.ts`: renderer construction and stable TUI proxy.

## Issues to address before calling the port usable

### Geometry must describe both full bounds and clipping

The old `SurfaceRect` reports a visible rectangle and `totalRows`. That is insufficient. A 20-row component with visible rectangle `(row=0, rows=10)` could have ten rows clipped above, ten below, or some at both ends. A consumer cannot recover its logical origin from those values alone. Katzensteg currently attempts that reconstruction.

Use explicit full bounds and a visible clip in terminal cells, with one documented zero-based coordinate convention. Full bounds can start above the screen. Clip must account for the containing scroll viewport, not just terminal dimensions. Content size and allocated bounds may also differ, as with a cursor-scrolled leaf; the contract must describe the content offset where necessary.

The same committed geometry must drive chrome, external placement, and hit-testing. Requested overlay options are not geometry. A move beyond the bottom edge must report the actual clamped position, so graphics cannot continue moving after chrome stops.

Fullscreen already computes the necessary distinction for layout nodes. However, a plain `Container` is a leaf in `LayoutFrame`; its children are absent from that tree. A probe confirmed this. The coding-agent transcript uses ordinary containers, so walking only fullscreen `LayoutBox.children` will miss inline surfaces. Padding in `Box`, wrappers, nested scroll views, and horizontal stacks must all be represented without rerendering children just to discover their positions.

Regular mode needs its own mapping from rendered document coordinates to the physical screen, including nonzero startup cursor row, scrolling, shrinking, and resize. A fullscreen scroll offset cannot substitute for that mapping. The old branch's cursor-origin work is relevant, but its viewport high-water changes need validation against the newer renderer rather than wholesale copying.

### Reuse upstream mouse input and strengthen gesture lifetime

Fullscreen already handles press, release, move, drag, click, and wheel. Handlers can return `handled`, `capture`, `focus`, and `render`. Keep one dispatcher/event model and leave producer-specific input encoding in the extension.

Current capture stores the target's origin and dimensions at dispatch time. A moving/resizing surface needs current transforms for later events; otherwise local coordinates remain tied to its old position. Capture also needs cancellation when a component disappears, becomes hidden, or loses its renderer. A probe confirmed that a fullscreen overlay still receives drag/release after `hide()` and a completed render.

Regular mode received no normalized mouse events in the corresponding probe. Its mouse mode should be enabled only when requested, so normal terminal selection remains the default. Fullscreen already owns terminal mouse mode, selection, wheel scrolling, and scrollbar gestures; surface input must cooperate with those behaviors.

The upstream event model differs from the old `PointerEvent`: names, button representation, synthesized click events, and wheel units differ. In particular, fullscreen wheel deltas include its configured scroll multiplier. Keep physical input semantics distinct from viewport scrolling policy if consumers need raw wheel steps or pressed-button state. Adapt Katzensteg at its own extension boundary.

### External graphics need redraw and output ordering contracts

Fullscreen `doRender()` can issue `deleteAllKittyPlacements()` when built-in image lines change and global image deletion on some full redraws. These writes also affect external placements that Pi does not track. Regular mode still uses screen clears on some redraw paths. Publishing geometry only when it changes cannot restore graphics after a clear that leaves geometry unchanged.

Provide a post-commit notification that distinguishes geometry changes from graphics invalidation. An extension must know whether it needs to replace placements or retransmit image data. Callbacks must run after the renderer's terminal writes, including frames with unchanged text and frames that only remove content.

Raw extension output needs ordered writes and renderer-specific cursor restoration. Restoring the cursor alone cannot make arbitrary terminal control bytes safe: callers must preserve Pi's text grid and modes. Document that contract explicitly.

Image ID ownership and broad deletion remain design work. Prefer retaining upstream's built-in image management while notifying registered external surfaces of invalidation; evaluate targeted deletion where it prevents needless external redraw. Do not embed Katzensteg frame decoding or producer buffering in Pi. An asynchronous producer can still return a frame for old geometry, so its extension must reject stale output or request a new frame.

### Registrations need lifecycle ownership

The old branch leaks inline handle registrations on message removal and can focus a removed overlay after its close callback. Do not carry those paths forward.

Define attachment, temporary invisibility, replacement, and disposal separately. Scrolling out of view should release focus/capture and publish invisibility; it should not dictate whether an external process is paused or killed. Replacement/removal must release host listeners exactly once and let the extension clean up its own resources. A fresh renderer factory must not retain subscriptions from the previous returned component.

The current Katzensteg renderer creates a new controller and producer per factory invocation. Its consumer will need to participate in the generic cleanup contract; adding host cleanup alone will not stop its external processes.

The TUI proxy routes future method calls to a new renderer, but cannot automatically move a previously returned subscription or overlay handle. Renderer switching therefore needs explicit attachment rebinding or a documented teardown/recreate lifecycle. Late callbacks from the old renderer must not write into the new screen.

Focus restoration must cooperate with upstream's overlay restoration state. Include a configurable release action, click outside, scroll-out, hide, removal, and reentrant close callbacks. Keep upstream modal dialogs and search behavior intact.

## Proposed implementation sequence

1. **Geometry and lifecycle foundation.** Define full bounds, clip, content offset, and attachment state. Report rendered child transforms for ordinary containers/wrappers. Publish geometry after terminal commit in both renderers. Start with an inert generic component and overlay tests.
2. **Mouse/focus integration.** Reuse `handleMouse`, share normalization where appropriate, add opt-in regular-mode delivery, and make capture/focus lifetime follow attachments. Verify existing fullscreen selection and wheel fallbacks.
3. **External drawing.** Add ordered cursor-safe writes and graphics invalidation notifications. Exercise coexistence with built-in images and renderer changes. Use a generated checkerboard or gradient; no external executable is needed.
4. **Coding-agent attachment.** Expose the generic surface to inline message renderers and existing custom overlays. Wire replacement/removal/shutdown cleanup and renderer switching.
5. **Dynamic overlay layout and consumer check.** Add option updates and explicit allocated height where needed. Exercise move/resize using committed bounds. Update the Katzensteg extension separately to consume the resulting interface.

This is a manual port onto the new base. The old commits supply behavior and regression cases; their pointer dispatcher, TUI constructor, and viewport internals should not be replayed unchanged. Existing upstream APIs remain intact. The private branch's extension interface can change without compatibility aliases.

## Acceptance cases

- The same generic component works inline and as an overlay in regular and fullscreen modes.
- Bounds/clip agree with actual rendered cells through nested padding, horizontal layout, top/bottom/both-edge clipping, and nonzero regular-mode startup position.
- Drag below every terminal edge, release, and start another drag. Chrome, graphics, and hit-testing remain aligned.
- Hide/remove during press or capture; subsequent keyboard and mouse input reaches a live target.
- Scroll a focused inline surface out of view; composer focus returns and capture ends.
- Rebuild/theme changes/session replacement do not accumulate host subscriptions or consumer instances.
- Built-in image redraw, resize, and forced redraw trigger the required external graphics recovery even if geometry is unchanged.
- Mode switching/external-editor suspension cancels old writes and restores or recreates attachments deliberately.
- No surface registration leaves regular-mode terminal mouse reporting enabled after cleanup.
- No graphics-related code or test in Pi requires Katzensteg, its protocol, or a running producer.

## Validation performed

- Installed only the TUI workspace dependencies using `npm ci --ignore-scripts --workspace packages/tui`; no lifecycle scripts or lockfile edits.
- Upstream targeted tests passed: `layout.test.ts`, `mouse-components.test.ts`, `tui-alt-screen.test.ts`, `overlay-non-capturing.test.ts`, `overlay-options.test.ts`, and `tui-render.test.ts`.
- Temporary runtime probes confirmed opaque ordinary-container geometry, lack of regular-mode normalized mouse dispatch, and fullscreen capture delivery after overlay removal. Probe files were removed.
- No implementation changes, full repository checks, real terminal graphics validation, or end-to-end Katzensteg tests were performed in this exploration.
