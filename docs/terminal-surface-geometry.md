# Terminal surface geometry

Both `TuiMainScreen` and `TuiAltScreen` expose `tui.trackSurface(component)`. The returned `SurfaceHandle` observes the component's committed terminal-cell geometry without rendering it again.

```ts
const surface = tui.trackSurface(component);
const unsubscribe = surface.onGeometryChange((geometry) => {
	if (!geometry || geometry.clip.width === 0 || geometry.clip.height === 0) return;
	// Inspect geometry.bounds, geometry.clip, and geometry.contentOffset.
});

// When the owning extension or component is removed:
unsubscribe();
surface.dispose();
```

All coordinates are zero-based. `bounds` is the allocated rectangle before clipping and may extend outside the terminal. `clip` is its intersection with containing viewports; it does not subtract overlapping overlays. `occlusions` reports rectangles covered by overlays above the surface, in absolute terminal cells. Consumers can subtract these rectangles when placing external graphics. `contentOffset` identifies the source row displayed at the top of an allocated leaf when the renderer scrolls its content to keep the cursor visible.

An offscreen component retains bounds with an empty clip. A component that is absent or hidden has undefined geometry. Regular mode also reports undefined geometry until it knows its physical screen position from the startup cursor report or a render that establishes the viewport origin. Text rendering does not wait for that report.

The listener receives its initial snapshot synchronously. Later deliveries follow terminal writes, occur only when geometry changes, and see all handles updated to the same committed frame. Returned snapshots are defensive copies. A render requested from a callback is deferred. Exceptions from subsequent listener deliveries are isolated from other listeners.

Removing a component does not dispose an explicitly created handle: the registration can observe it again if it is reinserted. Its owner must dispose it when finished. Disposal is idempotent, clears geometry listeners, and delivers a final render callback for graphics cleanup. Stopping the renderer publishes undefined geometry and disposes all registrations before releasing the terminal; callers must register again after restart or renderer replacement.

Ordinary containers and wrappers expose `Component.getRenderedChildren()`, returning child rectangles in parent-local cells from their last render. A custom wrapper must implement this method for its descendants to be discoverable. It must record positions while rendering and must not render again when queried. Fullscreen layout caches preserve these child snapshots alongside their rendered lines. Register each component instance at a single rendered location.

## Mouse input and focus

Use `tui.trackSurface(component, { mouse: true })` to request mouse reporting in regular mode. The request lasts until disposal or renderer stop. Multiple requests share terminal mouse mode; disposing the last one restores native terminal selection. Reporting enables normalized `handleMouse` dispatch across the TUI, including its overlays and ordinary controls. Fullscreen keeps its existing mouse configuration, selection, and scrolling policies.

Components use the existing `handleMouse(event)` result fields: `handled`, `capture`, `focus`, and `render`. Captured events follow committed bounds after movement or resizing. A generic terminal release retains the pressed button. `wheelSteps` reports physical vertical steps; `wheelDelta` retains the renderer's logical scrolling amount, including fullscreen acceleration.

Implement `handleMouseCancel()` to clear component-owned pressed state when capture is cancelled by hiding, removal, disposal, focus loss, renderer stop, or a new press after a lost release. Normal release ends the gesture without calling this hook. A component removed or disposed inside its handler cannot reclaim focus/capture through its return value.

When a registered inline component requests focus through a mouse result, pi remembers the previous focus target. It restores that target when the surface disappears, scrolls entirely out of view, is disposed, receives an outside press, or the user invokes `tui.surface.releaseFocus` (Ctrl-G by default). Existing overlay focus restoration remains responsible for overlay focus. Explicit programmatic focus changes are owned by their caller.

## External drawing

`surface.onRender(callback)` runs after each committed frame, including frames with unchanged text or geometry. It schedules an initial render. Each callback receives:

- `geometry`: the same committed bounds/clip as `getGeometry()`.
- `revision`: changes when geometry or graphics validity changes; idle frames retain it.
- `graphicsInvalidation`: `none`, `placements`, or `images`.
- `disposed`: marks the final cleanup delivery.
- `write(data)`: writes complete terminal sequences synchronously, preserving pi's cursor.

`placements` means existing placements may need to be recreated, but uploaded image data can be reused. `images` means callers must also assume their uploaded data is unavailable. These notifications are conservative: line erasure, scrolling, screen clearing, built-in image redraws, resize, and cell-size reports can invalidate external graphics. Geometry change notifications alone cannot recover them.

For example, given a PNG in `imageData`, a simple consumer can retransmit on every committed frame:

```ts
import { allocateImageId, deleteKittyImage, encodeKitty } from "@earendil-works/pi-tui";

const imageId = allocateImageId();
const surface = tui.trackSurface(component);
surface.onRender((frame) => {
	const clip = frame.geometry?.clip;
	if (frame.disposed || !clip || clip.width === 0 || clip.height === 0) {
		frame.write(deleteKittyImage(imageId));
		return;
	}
	// This simple example scales the entire image into the visible rectangle.
	frame.write(
		`\x1b[${clip.y + 1};${clip.x + 1}H` +
		encodeKitty(imageData, {
			imageId, columns: clip.width, rows: clip.height, moveCursor: false,
		}),
	);
});
```

A consumer can instead cache uploads and use placement-only updates when appropriate. Allocate IDs for your own images; never delete another component's images. Pi does not decode, crop, or replay external packets. The consumer owns pixel cropping and graphic layering, including overlap with overlays.

Writes are valid only during the synchronous callback that supplied them. A retained writer returns `false` after that callback, disposal, or a renderer lifetime change. An asynchronous producer should store its completed result and call `surface.requestRender()`, then check that the result still fits the current geometry before writing it. Producer output can be keyed by geometry and content version; `revision` also changes for graphics invalidation.

The writer preserves cursor position around each write. Payloads must preserve pi's text cells, terminal modes, and cursor save slot; they must not scroll the terminal or contain their own cursor save/restore commands. Use image commands that suppress automatic cursor movement. Each write must contain complete sequences, including every chunk of a chunked image transmission.

When a surface becomes absent or clipped out, its callback can remove its old placements. `dispose()` delivers a final callback with undefined geometry and `disposed: true`; keep the render listener subscribed through disposal if it owns graphics cleanup. Disposal during component rendering defers cleanup until after text output. Listener failures do not block other consumers or cursor restoration.

## Custom-message ownership

Coding-agent supplies `options.ui` to interactive `registerMessageRenderer` factories. It exposes `trackSurface(component, options)` and `onDispose(callback)`. Both belong to that factory invocation:

```ts
pi.registerMessageRenderer("external-panel", (message, options, theme) => {
	const panel = createPanel(message.details, theme);
	if (!options.ui) return panel;
	const surface = options.ui.trackSurface(panel, { mouse: true });
	const producer = startProducer(panel, surface);
	options.ui.onDispose(() => producer.stop());
	return panel;
});
```

Here `createPanel` and `startProducer` are extension code. Pi has no producer protocol, process management, or Katzensteg dependency. The producer stores completed output and requests frames through the surface; its graphics callback follows the drawing contract above.

Factories run after a committed frame, outside text rendering. A newly attached message reserves its spacer until the factory's component is ready for the next frame. Expansion, padding changes, and invalidation rebuild the factory on a subsequent frame. Pi disposes its previous surface handles first, then invokes resource cleanup callbacks and the returned component's optional `dispose()` method. Returning undefined or throwing also releases the invocation's resources before default message rendering takes over. Cleanup callbacks must be synchronous; stop producers and revoke their pending work there.

Transcript removal, session replacement, and extension reload release the message's resources. Renderer stop does the same before releasing the terminal. Resume and renderer switching invoke the factory again with a fresh context. Old contexts reject new surface registrations. An extension must not retain its context across invocations.

Shutdown transcript output reuses the last rendered lines at the same width. If the width differs, it uses the default message content. It never calls a disposed producer to render again. Standalone `CustomMessageComponent` callers can pass their TUI as the fifth constructor argument and must call `dispose()` when removing the message. Without a host TUI, `options.ui` is absent.

`tui.isRunning` reports whether the current renderer owns the terminal for interactive output; it is false before startup and during shutdown cleanup.

## Dynamic overlays

`OverlayHandle.updateOptions(patch)` merges options and schedules a render. An undefined field restores that option's default. Position updates do not change visual stacking order or claim focus. Changing visibility to false restores focus if the overlay owned it. Changing `nonCapturing` controls subsequent automatic focus when showing the overlay; explicit `focus()` still works.

`OverlayOptions.height` allocates an exact number of rows, or a percentage of terminal height. Short content is padded and long content is clipped. The allocation is capped by `maxHeight` and the space inside terminal margins. Omitting height retains natural content sizing.

```ts
const overlay = tui.showOverlay(panel, { width: 40, height: 12 });
overlay.updateOptions({ row: requestedRow, col: requestedCol });
// After the next frame, read actual clamped geometry from the surface callback
// or overlay.getBounds(). Never position graphics from requestedRow/requestedCol.
```

`getBounds()` continues to describe the last rendered frame until the update commits. The surface, panel chrome, and captured mouse coordinates follow that committed rectangle. Updates to a permanently removed overlay are ignored, including attempts to show or focus it again. Calling `setHidden()` temporarily retains the overlay and its registrations; the owner still disposes explicit surface handles when finished.

`overlay.onDispose(callback)` observes permanent removal, including `tui.hideOverlay()`. Temporary hiding does not invoke it. Registering after removal invokes the callback immediately. The returned function unsubscribes.

Coding-agent custom overlays receive this handle through the existing `onHandle` option. Their factory's `overlayOptions` function is evaluated at creation; later changes should use `updateOptions()`.

The TUI passed to `ctx.ui.custom()` owns surface registrations for that prompt. Calling `done(result)` removes that particular overlay, preserving any newer overlay above it. It disposes surfaces before calling the returned component's optional `dispose()` method. Factory failures, `onHandle` failures, permanent overlay removal, host cancellation/reload, and renderer shutdown also clean up. An async factory that resolves after closure has its returned component disposed without mounting it. Further surface registration through its old TUI reference throws.

Host cancellation, permanent removal, and renderer shutdown reject the pending custom-UI promise. Unlike transcript messages, prompts are cancelled rather than recreated on resume. Extensions should catch the rejection and close their own application state. During temporary hiding, the prompt and producer remain alive; use geometry visibility to suspend work if desired.

The external Katzensteg adapter uses presentation generations to filter stale placements. It retains file-backed transport and relies on continuous full-frame updates after graphics invalidation; recovery for paused producers remains deferred. Those policies belong to the adapter, not pi.
