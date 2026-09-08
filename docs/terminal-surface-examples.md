# Terminal surface examples

Run the ported examples from this worktree in Kitty or Ghostty:

```sh
cd ~/dev/pi-terminal-surfaces
./pi-test.sh --no-session --no-extensions --tui-mode regular \
  -e ./packages/coding-agent/examples/extensions/terminal-surface-demo.ts \
  -e ./packages/coding-agent/examples/extensions/viewport-drift-repro.ts
```

Repeat with `--tui-mode fullscreen`. These commands use local sources; no build or model prompt is needed.

## Surface demo

- `/terminal-surface-demo` toggles the floating gradient panel.
- Drag the title to move it. Drag borders and corners to resize it. Move beyond the bottom edge, release, then drag again: chrome and image should remain together and input should recover.
- Click or drag inside the image to move the marker. Arrow keys move it while focused. The status line maps its cell coordinates to the original image pixels.
- Click the top-right close button, use Escape while focused, or press Ctrl+G to close the floating panel. These keys follow the configured selection-cancel and surface-release bindings.
- `/terminal-surface-demo inline` adds an inline panel. Click to focus; Ctrl+G returns to the composer. Add several inline panels and scroll in fullscreen mode to check clipping and focus release.
- Resize the terminal, including below the panel's minimum usable size, then enlarge it. Check that borders and image recover. Close/reopen and suspend/resume to check that old images disappear.

The demo uses committed `SurfaceGeometry`, `handleMouse`/`handleMouseCancel`, `OverlayHandle.updateOptions`, and callback-scoped graphics writes. It owns one Kitty image ID, crops its placement to the visible rectangle, reuploads after image invalidation, and deletes image data during surface disposal. It has no Katzensteg dependency. Terminals without Kitty graphics support can exercise the text and input paths but will not show the gradient.

## Viewport drift

Run `/viewport-drift-repro`, then type and erase `/` in the composer to expand and collapse autocomplete. The ticking panel should remain anchored at the right-center of the viewport. Run the command again to close it; disposal stops its timer.
