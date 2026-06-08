/**
 * Minimal TUI implementation with differential rendering
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { isKeyRelease, matchesKey } from "./keys.ts";
import { type PointerEvent, parsePointerEvent } from "./pointer-events.ts";
import type { Terminal } from "./terminal.ts";
import { deleteKittyImage, getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.ts";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

function rectContains(rect: OverlayRect, row: number, col: number): boolean {
	return row >= rect.row && row < rect.row + rect.rows && col >= rect.col && col < rect.col + rect.cols;
}

function extractKittyImageIds(line: string): number[] {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return [];

	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return [];

	const params = line.slice(paramsStart, paramsEnd);
	for (const param of params.split(",")) {
		const [key, value] = param.split("=", 2);
		if (key !== "i" || value === undefined) continue;
		const id = Number(value);
		if (Number.isInteger(id) && id > 0 && id <= 0xffffffff) {
			return [id];
		}
	}
	return [];
}

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Fixed height in rows, or percentage of terminal height (e.g., "50%") */
	height?: SizeValue;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	nonCapturing?: boolean;
}

/** Options for {@link OverlayHandle.unfocus}. */
export interface OverlayUnfocusOptions {
	/** Explicit target to focus after releasing this overlay. */
	target: Component | null;
}

export interface SurfaceRect {
	/** Zero-based row within the visible terminal viewport. */
	row: number;
	/** Zero-based column within the visible terminal viewport. */
	col: number;
	/** Visible row count (may be smaller than the surface's full row count if partially scrolled). */
	rows: number;
	/** Visible column count. */
	cols: number;
	/**
	 * Total unclipped row count of the component (may exceed `rows` when the component
	 * is height-clamped or partially scrolled off screen).
	 */
	totalRows: number;
}

/** Backwards-compatible alias for code referring to the v1 name. */
export type OverlayRect = SurfaceRect;

/**
 * Plugin-facing API for an interactive surface (overlay or inline message).
 * Subtypes may add lifecycle methods specific to their placement model.
 */
export interface SurfaceHandle {
	/** Get the current visible viewport rect for this surface, or undefined if hidden / not rendered / fully scrolled out. */
	getRect(): SurfaceRect | undefined;
	/** Listen for visible rect changes. Listener is called immediately with current state. */
	onRectChange(listener: (rect: SurfaceRect | undefined) => void): () => void;
	/** Subscribe to pointer events that hit this surface's rect. */
	onPointer(listener: (event: PointerEvent) => void, options?: { wheel?: boolean; hover?: boolean }): () => void;
	/** Focus this surface and bring it to the visual front for keyboard dispatch. */
	focus(): void;
	/** Release focus to the previous target. */
	unfocus(): void;
	/** Check if this surface currently has focus. */
	isFocused(): boolean;
}

/**
 * Handle returned by showOverlay. Extends SurfaceHandle with overlay-specific
 * programmatic lifecycle methods.
 */
export interface OverlayHandle extends SurfaceHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
	unfocus(options?: OverlayUnfocusOptions): void;
}

/**
 * Handle for an inline `registerMessageRenderer` component. Same plugin-facing
 * surface API as `OverlayHandle` but without programmatic lifecycle methods —
 * inline messages exist for the lifetime of their chat message.
 */
export interface MessageHandle extends SurfaceHandle {
	// No additions. Inline message lifecycle is owned by the chat layer.
}

type PointerListenerEntry = {
	listener: (event: PointerEvent) => void;
	wheel: boolean;
	hover: boolean;
};

type OverlayStackEntry = {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
	lastRect: OverlayRect | undefined;
	rectListeners: Set<(rect: OverlayRect | undefined) => void>;
	pointerListeners: Set<PointerListenerEntry>;
	mouseModeRelease: (() => void) | undefined;
};

type OverlayBlockedFocusResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
type EligibleOverlayFocusRestoreState = { status: "eligible"; overlay: OverlayStackEntry };
type BlockedOverlayFocusRestoreState = {
	status: "blocked";
	overlay: OverlayStackEntry;
	blockedBy: Component;
	resume: OverlayBlockedFocusResume;
};
type ActiveOverlayFocusRestoreState = EligibleOverlayFocusRestoreState | BlockedOverlayFocusRestoreState;
type OverlayFocusRestoreState = { status: "inactive" } | ActiveOverlayFocusRestoreState;
type OverlayFocusRestorePolicy = "clear" | "preserve";

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];
	private childOffsets = new Map<Component, { startLine: number; lineCount: number }>();

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
		this.childOffsets.delete(component);
	}

	clear(): void {
		this.children = [];
		this.childOffsets.clear();
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		this.childOffsets.clear();
		const lines: string[] = [];
		for (const child of this.children) {
			const startLine = lines.length;
			const childLines = child.render(width);
			this.childOffsets.set(child, { startLine, lineCount: childLines.length });
			for (const line of childLines) {
				lines.push(line);
			}
		}
		return lines;
	}

	/**
	 * Returns the start line and line count of the given child as recorded by the most recent
	 * call to `render(width)`. Returns undefined if the child was not part of the most recent
	 * render. Useful for computing per-child viewport positions in higher-level containers.
	 */
	getChildOffset(child: Component): { startLine: number; lineCount: number } | undefined {
		return this.childOffsets.get(child);
	}

	/**
	 * Iterates this container's rendered children, invoking `visitor` once per child
	 * with its start line and line count from the most recent render. Children that
	 * have no recorded offset (i.e., were not part of the most recent render) are skipped.
	 *
	 * This is the encapsulated iteration protocol used by `TUI.trackComponent`'s walk.
	 * External code should prefer this over reading `children` and calling `getChildOffset`
	 * directly.
	 */
	forEachChild(visitor: (child: Component, startLine: number, lineCount: number) => void): void {
		for (const child of this.children) {
			const offset = this.childOffsets.get(child);
			if (offset === undefined) continue;
			visitor(child, offset.startLine, offset.lineCount);
		}
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	public terminal: Terminal;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<InputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private afterNextRenderCallbacks: Array<() => void> = [];
	private pendingOverlayRectFires: Array<() => void> = [];
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private cursorRow = 0; // Logical cursor row (end of rendered content)
	private hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	private hardwareCursorCol = 0; // Actual terminal cursor column
	private showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1";
	private clearOnShrink = process.env.PI_CLEAR_ON_SHRINK === "1"; // Clear empty rows when content shrinks (default: off)
	private maxLinesRendered = 0; // Track terminal's working area (max lines ever rendered)
	private previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves
	private lastRenderBranch = "init";
	private bufferLengthHighWater = 0; // Render pads up to this so viewportTop only grows until next resize
	private previousRealLength = 0; // Last render's unpadded line count (for shrink-detection)
	private fullRedrawCount = 0;
	private stopped = false;
	private mouseModeRefcount = 0;
	private pluginFocused = false;
	private defaultFocus: Component | null = null;
	private inlinePointerDispatcher: ((event: PointerEvent) => boolean) | undefined = undefined;

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: OverlayStackEntry[] = [];
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };

	// Component rect tracking: maps tracked components to their listener + last rect
	private componentLabels = new WeakMap<Component, number>();
	private componentLabelCounter = 0;
	private trackedComponents = new Map<
		Component,
		{
			listener: (rect: SurfaceRect | undefined) => void;
			lastRect: SurfaceRect | undefined;
		}
	>();

	constructor(terminal: Terminal, showHardwareCursor?: boolean) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	/** Index of the first visible buffer line in the current viewport. */
	get viewportTop(): number {
		return Math.max(0, this.previousLines.length - this.terminal.rows);
	}

	/**
	 * The viewport top the renderer last actually applied. Differs from `viewportTop`
	 * (live, recomputed from current `previousLines.length`) when the differential
	 * render path has not yet reconciled a shrink — text on screen is positioned per
	 * this value, so consumers computing screen rects for content that must align with
	 * rendered text should use this, not `viewportTop`.
	 */
	get renderedViewportTop(): number {
		return this.previousViewportTop;
	}

	/** Write opaque terminal bytes without TUI escaping or compositing. */
	writeRaw(data: string): void {
		this.terminal.write(data);
		this.restoreHardwareCursorAfterRawWrite();
	}

	/**
	 * Acquire mouse-mode reporting. Refcounted across callers.
	 * Returns a release function; mouse mode disables when the refcount reaches zero.
	 * Calling the release function twice is a no-op.
	 */
	acquireMouseMode(): () => void {
		if (this.mouseModeRefcount === 0) {
			this.terminal.write("\x1b[?1003h\x1b[?1006h");
		}
		this.mouseModeRefcount++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (this.mouseModeRefcount <= 0) return;
			this.mouseModeRefcount--;
			if (this.mouseModeRefcount === 0) {
				this.terminal.write("\x1b[?1003l\x1b[?1006l");
			}
		};
	}

	/** Run a callback after the next render has been flushed to the terminal. */
	afterNextRender(callback: () => void): void {
		this.afterNextRenderCallbacks.push(callback);
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	setFocus(component: Component | null): void {
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	private setFocusInternal({
		component,
		overlayFocusRestore,
	}: {
		component: Component | null;
		overlayFocusRestore: OverlayFocusRestorePolicy;
	}): void {
		const previousFocus = this.focusedComponent;
		let nextFocus = component;
		const previousFocusedOverlay = previousFocus
			? this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: undefined;
		const nextFocusIsOverlay = nextFocus ? this.overlayStack.some((entry) => entry.component === nextFocus) : false;
		const restoreState = this.getVisibleOverlayFocusRestore();
		if (nextFocus && !nextFocusIsOverlay) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
					nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
				} else {
					this.overlayFocusRestore = {
						status: "blocked",
						overlay: restoreState.overlay,
						blockedBy: nextFocus,
						resume: restoreState.resume,
					};
				}
			} else if (
				previousFocusedOverlay &&
				restoreState.status !== "inactive" &&
				restoreState.overlay === previousFocusedOverlay &&
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				this.overlayFocusRestore = {
					status: "blocked",
					overlay: previousFocusedOverlay,
					blockedBy: nextFocus,
					resume: { status: "restore-overlay" },
				};
			}
		} else if (nextFocus === null) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
			} else if (overlayFocusRestore === "clear") {
				this.clearOverlayFocusRestore();
			}
		}

		if (nextFocus !== previousFocus) {
			this.pluginFocused = false;
		}
		// Clear focused flag on old component
		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}
		this.focusedComponent = nextFocus;

		if (isFocusable(nextFocus)) {
			nextFocus.focused = true;
		}
		const focusedOverlay = nextFocus
			? this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: undefined;
		if (focusedOverlay) {
			this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
		}
		this.requestRender();
	}

	private clearOverlayFocusRestore(): void {
		this.overlayFocusRestore = { status: "inactive" };
	}

	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			this.clearOverlayFocusRestore();
		}
	}

	private resolveBlockedOverlayFocusResume(restoreState: BlockedOverlayFocusRestoreState): Component | null {
		if (restoreState.resume.status === "restore-overlay") return restoreState.overlay.component;
		this.clearOverlayFocusRestore();
		return restoreState.resume.target;
	}

	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.status === "inactive") return restoreState;
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			return { status: "inactive" };
		}
		return restoreState;
	}

	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		const visited = new Set<Component>();
		let current = entry.preFocus;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current === component) return true;
			current = this.overlayStack.find((overlay) => overlay.component === current)?.preFocus ?? null;
		}
		return false;
	}

	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.overlayStack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	private isComponentMounted(component: Component): boolean {
		return this.children.some((child) => this.containsComponent(child, component));
	}

	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		if (!(root instanceof Container)) return false;
		return root.children.some((child) => this.containsComponent(child, target));
	}

	/**
	 * Configure the "default" focused component to return to when plugin focus
	 * is released (Esc, click-outside, scroll-out, overlay hide). Typically set
	 * once at startup by the host (e.g. Pi's interactive mode points this at
	 * the editor/composer). Setting does not change current focus; it only
	 * affects future release paths.
	 */
	setDefaultFocus(component: Component | null): void {
		this.defaultFocus = component;
	}

	/**
	 * Register a dispatcher for pointer events that didn't match any overlay. Called after
	 * the overlay-iteration loop in `dispatchPointerEvent`. Returns true if the dispatcher
	 * consumed the event (prevents click-outside plugin-focus release). Pass `undefined` to clear.
	 */
	setInlinePointerDispatcher(dispatcher: ((event: PointerEvent) => boolean) | undefined): void {
		this.inlinePointerDispatcher = dispatcher;
	}

	/**
	 * Register a component for rect tracking. The listener fires via
	 * `afterNextRender` whenever the rect changes (field-by-field diff). On the
	 * first render after registration, if the component is in the tree, the
	 * listener fires once with the computed rect (undefined → defined is a
	 * change). Returns an unregister thunk; safe to call repeatedly (idempotent).
	 * Calling `trackComponent` again for the same component replaces the previous
	 * registration; the previous unregister thunk remains safe to call (it becomes
	 * a no-op via identity check).
	 *
	 * Tracked components are resolved by walking `Container.children` from the
	 * TUI root via `Container.forEachChild`; descendants reachable only outside
	 * that protocol (e.g., rendered "manually" inside a non-Container's render
	 * output) are not trackable.
	 *
	 * This is an internal-ish API for handle implementations (`OverlayHandle`,
	 * `MessageHandle`). Plugins consume rect updates via the handle's own
	 * `onRectChange`, which performs synchronous initial delivery.
	 */
	trackComponent(component: Component, listener: (rect: SurfaceRect | undefined) => void): () => void {
		const entry = { listener, lastRect: undefined as SurfaceRect | undefined };
		this.trackedComponents.set(component, entry);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (this.trackedComponents.get(component) === entry) {
				this.trackedComponents.delete(component);
			}
		};
	}

	/**
	 * Set focus to a plugin component (overlay or inline message). Sets the
	 * pluginFocused flag so Pi-enforced release paths (Esc, click-outside,
	 * scroll-out, overlay hide) restore focus to the configured default
	 * (`setDefaultFocus`). Internal Pi callers and external Pi-extension
	 * dispatchers both go through this method.
	 */
	setPluginFocus(component: Component): void {
		this.setFocus(component);
		this.pluginFocused = true;
	}

	/**
	 * Release plugin focus and restore the configured default focus target.
	 * Used by Pi-enforced release paths (Esc, click-outside, overlay hide).
	 * Safe to call when plugin focus is not active — caller must guard
	 * unless the no-op is intentional. (Currently all callers guard.)
	 */
	private releasePluginFocus(): void {
		this.setFocus(this.defaultFocus);
		this.pluginFocused = false;
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
			lastRect: undefined,
			rectListeners: new Set(),
			pointerListeners: new Set(),
			mouseModeRelease: undefined,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					this.updateOverlayRect(entry, undefined);
					// Release plugin focus if this overlay holds it
					if (this.focusedComponent === entry.component && this.pluginFocused) {
						this.releasePluginFocus();
					}
					// Clean up pointer listeners and mouse mode
					if (entry.mouseModeRelease) {
						entry.mouseModeRelease();
						entry.mouseModeRelease = undefined;
					}
					entry.pointerListeners.clear();
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// Release plugin focus if this overlay holds it
					if (this.focusedComponent === entry.component && this.pluginFocused) {
						this.releasePluginFocus();
					}
					this.updateOverlayRect(entry, undefined);
					// Clear pointer listeners when hiding
					if (entry.mouseModeRelease) {
						entry.mouseModeRelease();
						entry.mouseModeRelease = undefined;
					}
					entry.pointerListeners.clear();
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				entry.focusOrder = ++this.focusOrderCounter;
				this.setFocus(component);
				this.requestRender();
			},
			unfocus: (unfocusOptions) => {
				const isFocused = this.focusedComponent === component;
				const restoreState = this.overlayFocusRestore;
				const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
				if (!isFocused && !hasPendingRestore) return;
				if (
					restoreState.status === "blocked" &&
					restoreState.overlay === entry &&
					this.focusedComponent === restoreState.blockedBy
				) {
					if (unfocusOptions) {
						this.overlayFocusRestore = {
							status: "blocked",
							overlay: entry,
							blockedBy: restoreState.blockedBy,
							resume: { status: "focus-target", target: unfocusOptions.target },
						};
					} else {
						this.clearOverlayFocusRestore();
					}
					this.requestRender();
					return;
				}
				this.clearOverlayFocusRestoreFor(entry);
				if (isFocused || unfocusOptions) {
					const topVisible = this.getTopmostVisibleOverlay();
					const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
					this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
				}
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
			getRect: () => entry.lastRect,
			onRectChange: (listener) => {
				entry.rectListeners.add(listener);
				listener(entry.lastRect);
				return () => {
					entry.rectListeners.delete(listener);
				};
			},
			onPointer: (
				listener: (event: PointerEvent) => void,
				options?: { wheel?: boolean; hover?: boolean },
			): (() => void) => {
				const ple: PointerListenerEntry = {
					listener,
					wheel: options?.wheel === true,
					hover: options?.hover === true,
				};
				entry.pointerListeners.add(ple);
				if (entry.pointerListeners.size === 1) {
					entry.mouseModeRelease = this.acquireMouseMode();
				}
				return () => {
					if (!entry.pointerListeners.has(ple)) return;
					entry.pointerListeners.delete(ple);
					if (entry.pointerListeners.size === 0 && entry.mouseModeRelease) {
						entry.mouseModeRelease();
						entry.mouseModeRelease = undefined;
					}
				};
			},
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		if (!overlay) return;
		this.clearOverlayFocusRestoreFor(overlay);
		this.retargetOverlayPreFocus(overlay);
		this.overlayStack.pop();
		// Release plugin focus if this overlay holds it
		if (this.focusedComponent === overlay.component && this.pluginFocused) {
			this.releasePluginFocus();
		}
		this.updateOverlayRect(overlay, undefined);
		// Clean up pointer listeners and mouse mode
		if (overlay.mouseModeRelease) {
			overlay.mouseModeRelease();
			overlay.mouseModeRelease = undefined;
		}
		overlay.pointerListeners.clear();
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	private updateOverlayRect(entry: OverlayStackEntry, rect: OverlayRect | undefined): void {
		const prev = entry.lastRect;
		const changed =
			prev?.row !== rect?.row ||
			prev?.col !== rect?.col ||
			prev?.rows !== rect?.rows ||
			prev?.cols !== rect?.cols ||
			prev?.totalRows !== rect?.totalRows;
		if (!changed) return;
		this.rectDebug("overlay-rect", {
			componentLabel: this.componentLabel(entry.component),
			nextRect: rect === undefined ? null : rect,
			prevRect: prev === undefined ? null : prev,
		});
		entry.lastRect = rect;
		// Listeners fire from flushAfterNextRenderCallbacks (after the terminal
		// write phase, so writeRaw is safe; before the afterNextRender snapshot,
		// so any scheduleDraw the listener queues lands in the same drain).
		const listeners = Array.from(entry.rectListeners);
		this.pendingOverlayRectFires.push(() => {
			for (const listener of listeners) {
				listener(rect);
			}
		});
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the visual-frontmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	private dispatchPointerEvent(event: PointerEvent): void {
		const overlaysByFocus = [...this.overlayStack].sort((a, b) => b.focusOrder - a.focusOrder);
		for (const entry of overlaysByFocus) {
			if (entry.hidden) continue;
			if (!entry.lastRect) continue;
			if (!rectContains(entry.lastRect, event.row, event.col)) continue;
			if (entry.pointerListeners.size === 0) continue;

			let delivered = false;
			for (const ple of entry.pointerListeners) {
				if (event.type === "wheel" && !ple.wheel) continue;
				if (event.type === "pointermove" && event.buttons === 0 && !ple.hover) continue;
				try {
					ple.listener(event);
				} catch {
					// Swallow listener exceptions so a single misbehaving plugin can't
					// break input dispatch for the rest of the host or other listeners.
				}
				delivered = true;
			}
			if (!delivered) continue;

			if (event.type === "pointerdown" && this.focusedComponent !== entry.component) {
				this.setPluginFocus(entry.component);
			}
			return;
		}
		// No overlay claimed the event. Try the inline dispatcher.
		if (this.inlinePointerDispatcher) {
			if (this.inlinePointerDispatcher(event)) {
				return;
			}
		}
		// Inline didn't consume (or no dispatcher registered). Release plugin focus on click-outside.
		if (event.type === "pointerdown" && this.pluginFocused) {
			this.releasePluginFocus();
		}
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(): void {
		this.stopped = false;
		this.terminal.start(
			(data) => this.handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.hideCursor();
		this.queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: InputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.inputListeners.delete(listener);
	}

	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop(): void {
		this.stopped = true;
		if (this.mouseModeRefcount > 0) {
			this.terminal.write("\x1b[?1003l\x1b[?1006l");
			this.mouseModeRefcount = 0;
		}
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit
		if (this.previousLines.length > 0) {
			const targetRow = this.previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.terminal.showCursor();
		this.terminal.stop();
	}

	requestRender(force = false): void {
		if (force) {
			this.previousLines = [];
			this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
			this.cursorRow = 0;
			this.hardwareCursorRow = 0;
			this.maxLinesRendered = 0;
			this.previousViewportTop = 0;
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			this.renderRequested = true;
			process.nextTick(() => {
				if (this.stopped || !this.renderRequested) {
					return;
				}
				this.renderRequested = false;
				this.lastRenderAt = performance.now();
				this.doRender();
			});
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TUI.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	private handleInput(data: string): void {
		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// Parse and dispatch pointer events (SGR mouse)
		const pointerEvent = parsePointerEvent(data);
		if (pointerEvent) {
			this.dispatchPointerEvent(pointerEvent);
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		const focusIsOverlay = this.overlayStack.some((o) => o.component === this.focusedComponent);
		if (!focusIsOverlay) {
			const restoreState = this.getVisibleOverlayFocusRestore();
			if (restoreState.status === "eligible") {
				this.setFocus(restoreState.overlay.component);
			} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
				if (restoreState.resume.status === "restore-overlay") {
					this.setFocus(restoreState.overlay.component);
				} else {
					this.clearOverlayFocusRestore();
					this.setFocus(restoreState.resume.target);
				}
			}
		}

		// Pi-enforced Esc release: when plugin focus is active, Esc returns to preFocus
		if (this.pluginFocused && matchesKey(data, "escape") && !isKeyRelease(data)) {
			this.releasePluginFocus();
			return;
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; height: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve height ===
		let fixedHeight = parseSizeValue(opt.height, termHeight);
		if (fixedHeight !== undefined) {
			fixedHeight = Math.max(1, Math.min(fixedHeight, availHeight));
		}

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by fixed height or maxHeight)
		const effectiveHeight =
			fixedHeight ?? (maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight);

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, height: effectiveHeight, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	private compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];

		// Pre-render all visible overlays and calculate positions
		const rendered: { entry: OverlayStackEntry; overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of this.overlayStack) {
			if (!this.isOverlayVisible(entry)) {
				this.updateOverlayRect(entry, undefined);
			}
		}
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight/fixed height.
			const {
				width,
				height: targetHeight,
				maxHeight,
			} = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);
			const rawLineCount = overlayLines.length;

			// Apply explicit height or maxHeight if specified
			if (options?.height !== undefined) {
				if (overlayLines.length > targetHeight) {
					overlayLines = overlayLines.slice(0, targetHeight);
				}
				if (overlayLines.length < targetHeight) {
					// Make a copy before mutating to avoid modifying component's output
					overlayLines = [...overlayLines];
					while (overlayLines.length < targetHeight) {
						overlayLines.push("");
					}
				}
			} else if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const {
				row,
				col,
				height: resolvedHeight,
			} = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ entry, overlayLines, row, col, w: width });
			this.updateOverlayRect(entry, { row, col, rows: resolvedHeight, cols: width, totalRows: rawLineCount });
			minLinesNeeded = Math.max(minLinesNeeded, row + resolvedHeight);
		}

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	private static readonly SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

	private applyLineResets(lines: string[]): string[] {
		const reset = TUI.SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private expandLastChangedForKittyImages(firstChanged: number, lastChanged: number): number {
		let expandedLastChanged = lastChanged;
		for (let i = firstChanged; i < this.previousLines.length; i++) {
			if (extractKittyImageIds(this.previousLines[i]).length > 0) {
				expandedLastChanged = Math.max(expandedLastChanged, i);
			}
		}
		return expandedLastChanged;
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = TUI.SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	private extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	private doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines
		let newLines = this.render(width);
		const realLength = newLines.length;
		const prevRealLength = this.previousRealLength;
		this.previousRealLength = realLength;

		// Pad newLines up to the high-water buffer length so viewportTop only grows
		// until resize. Reset on resize; the shrink-detection paths below use realLength
		// so they fire on real shrinks regardless of the padding.
		if (widthChanged || heightChanged) {
			this.bufferLengthHighWater = 0;
		}
		if (newLines.length < this.bufferLengthHighWater) {
			while (newLines.length < this.bufferLengthHighWater) {
				newLines.push("");
			}
		} else if (newLines.length > this.bufferLengthHighWater) {
			this.bufferLengthHighWater = newLines.length;
		}

		// Composite overlays into the rendered lines (before differential compare)
		if (this.overlayStack.length > 0) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (clear: boolean): void => {
			// A clearing redraw rebuilds the screen from scratch; the watermark cannot pin
			// a viewport position that no longer matches the new content. Release it and
			// emit only the real lines so the natural viewport reflects the actual buffer.
			// Skip when overlays are active: compositeOverlays grows newLines past
			// realLength to place overlay content; truncating would strip the overlays.
			if (clear && newLines.length > realLength && this.overlayStack.length === 0) {
				this.bufferLengthHighWater = realLength;
				newLines.length = realLength;
			}
			this.fullRedrawCount += 1;
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			if (clear) {
				buffer += this.deleteKittyImages(this.previousKittyImageIds);
				buffer += "\x1b[2J\x1b[H\x1b[3J"; // Clear screen, home, then clear scrollback
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max real lines when clearing, otherwise track growth.
			// Tracks real content size so clearOnShrink fires on real shrinks despite padding.
			if (clear) {
				this.maxLinesRendered = realLength;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, realLength);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.flushAfterNextRenderCallbacks();
		};

		const debugRedraw = process.env.PI_DEBUG_REDRAW === "1";
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const logPath = path.join(os.homedir(), ".pi", "agent", "pi-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.appendFileSync(logPath, msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			this.lastRenderBranch = "first-render";
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			this.lastRenderBranch = "width-changed";
			fullRender(true);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			this.lastRenderBranch = "height-changed";
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
		if (this.clearOnShrink && realLength < this.maxLinesRendered && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			this.lastRenderBranch = "clearOnShrink";
			fullRender(true);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			lastChanged = this.expandLastChangedForKittyImages(firstChanged, lastChanged);
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			this.lastRenderBranch = "no-changes";
			this.flushAfterNextRenderCallbacks();
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear).
		// Uses realLength so watermark padding doesn't hide a real shrink: with padding,
		// newLines.length stays at high-water, but firstChanged still lands at where the
		// real content shrunk to.
		if (firstChanged >= realLength) {
			if (this.previousLines.length > realLength) {
				let buffer = "\x1b[?2026h";
				buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
				// Move to end of new real content (clamp to 0 for empty content)
				const targetRow = Math.max(0, realLength - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					this.lastRenderBranch = "deleted-lines-fullrender";
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra rows where real content used to be (now padding under watermark,
				// or actually missing if no watermark). Use prevRealLength - realLength rather
				// than previousLines.length - newLines.length so padding doesn't mask the shrink.
				const extraLines = prevRealLength - realLength;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					this.lastRenderBranch = "deleted-lines-fullrender";
					fullRender(true);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					buffer += `\x1b[${clearStartOffset}B`;
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					buffer += `\x1b[${moveBack}A`;
				}
				buffer += "\x1b[?2026l";
				this.terminal.write(buffer);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			this.lastRenderBranch = "deleted-lines-only";
			this.flushAfterNextRenderCallbacks();
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			this.lastRenderBranch = "differential-fullrender";
			fullRender(true);
			return;
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		buffer += this.deleteChangedKittyImages(firstChanged, lastChanged);
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K"; // Clear current line
			const line = newLines[i];
			const isImage = isImageLine(line);
			if (!isImage && visibleWidth(line) > width) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(os.homedir(), ".pi", "agent", "pi-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			buffer += line;
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared).
		// Tracks real content size so clearOnShrink fires on real shrinks despite padding.
		this.maxLinesRendered = Math.max(this.maxLinesRendered, realLength);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
		this.lastRenderBranch = "differential";
		this.flushAfterNextRenderCallbacks();
	}

	/**
	 * After Container render has populated childOffsets across the tree, walk the
	 * tree once and deliver per-frame rect updates to all tracked components.
	 * Unvisited tracked components (no longer in the tree) receive `undefined`.
	 */
	private updateTrackedRects(): void {
		if (this.trackedComponents.size === 0) return;
		const unvisited = new Set(this.trackedComponents.keys());
		const walk = (container: Container, abs: number): void => {
			container.forEachChild((child, startLine, lineCount) => {
				const childAbs = abs + startLine;
				if (this.trackedComponents.has(child)) {
					this.deliverTrackedRect(child, childAbs, lineCount);
					unvisited.delete(child);
				}
				if (child instanceof Container) walk(child, childAbs);
			});
		};
		walk(this, 0);
		for (const stale of unvisited) {
			this.deliverTrackedRect(stale, undefined, 0);
		}
	}

	/**
	 * Compute the screen rect from absolute buffer offset + line count, diff
	 * against lastRect, and queue listener fire via afterNextRender on change.
	 * Passing `undefined` for bufferOffset signals "not in tree" → rect undefined.
	 */
	private deliverTrackedRect(component: Component, bufferOffset: number | undefined, lineCount: number): void {
		const entry = this.trackedComponents.get(component);
		if (!entry) return;
		let nextRect: SurfaceRect | undefined;
		if (bufferOffset !== undefined && lineCount > 0) {
			// Use renderedViewportTop (where the renderer last actually placed lines),
			// not live viewportTop (where lines would be after a perfect re-render).
			// Pi's differential render shrink path can leave the two diverged; using
			// the rendered value keeps our rect aligned with where text appears.
			const viewportTop = this.renderedViewportTop;
			const termRows = this.terminal.rows;
			const top = bufferOffset - viewportTop;
			const bottom = top + lineCount;
			const visTop = Math.max(0, top);
			const visBottom = Math.min(termRows, bottom);
			if (visBottom > visTop) {
				nextRect = {
					row: visTop,
					col: 0,
					rows: visBottom - visTop,
					cols: this.terminal.columns,
					totalRows: lineCount,
				};
			}
		}
		this.rectDebug("track-rect", {
			componentLabel: this.componentLabel(component),
			bufferOffset: bufferOffset === undefined ? null : bufferOffset,
			lineCount,
			viewportTop: this.viewportTop,
			renderedViewportTop: this.renderedViewportTop,
			nextRect: nextRect === undefined ? null : nextRect,
			prevRect: entry.lastRect === undefined ? null : entry.lastRect,
		});
		const prev = entry.lastRect;
		const changed =
			!!prev !== !!nextRect ||
			prev?.row !== nextRect?.row ||
			prev?.col !== nextRect?.col ||
			prev?.rows !== nextRect?.rows ||
			prev?.cols !== nextRect?.cols ||
			prev?.totalRows !== nextRect?.totalRows;
		if (!changed) return;
		entry.lastRect = nextRect;
		// Fire synchronously. updateTrackedRects runs inside
		// flushAfterNextRenderCallbacks, which itself runs after doRender's
		// terminal write phase — so writeRaw from inside a tracked-rect
		// listener does not interleave with this render's write bytes.
		// Crucially, firing synchronously here means the listener (which
		// typically updates plugin state read by drawImage/afterNextRender
		// callbacks) runs BEFORE the drain processes those callbacks, so
		// the first paint after a rect change happens in the same cycle
		// rather than waiting for a subsequent render.
		entry.listener(nextRect);
	}

	private flushAfterNextRenderCallbacks(): void {
		this.updateTrackedRects();
		if (this.pendingOverlayRectFires.length > 0) {
			const fires = this.pendingOverlayRectFires;
			this.pendingOverlayRectFires = [];
			for (const fire of fires) {
				fire();
			}
		}
		this.rectDebug("render-end", {
			branch: this.lastRenderBranch,
			previousLines: this.previousLines.length,
			termRows: this.terminal.rows,
			termCols: this.terminal.columns,
			viewportTop: this.viewportTop,
			previousViewportTop: this.previousViewportTop,
			hardwareCursorRow: this.hardwareCursorRow,
		});
		if (this.afterNextRenderCallbacks.length === 0) return;
		const callbacks = this.afterNextRenderCallbacks;
		this.afterNextRenderCallbacks = [];
		for (const callback of callbacks) {
			callback();
		}
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		this.hardwareCursorCol = targetCol;
		if (this.showHardwareCursor) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}

	private rectDebug(event: string, fields: Record<string, unknown>): void {
		if (process.env.PI_RECT_DEBUG !== "1") return;
		const logPath = path.join(os.homedir(), ".pi", "agent", "pi-rect-debug.log");
		const ts = new Date().toISOString();
		const body = Object.entries(fields)
			.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
			.join(" ");
		fs.appendFileSync(logPath, `[${ts}] ${event} ${body}\n`);
	}

	private componentLabelIndex(component: Component): number {
		let idx = this.componentLabels.get(component);
		if (idx === undefined) {
			idx = this.componentLabelCounter++;
			this.componentLabels.set(component, idx);
		}
		return idx;
	}

	private componentLabel(component: Component): string {
		const name = (component as { constructor?: { name?: string } }).constructor?.name ?? "Component";
		return `${name}#${this.componentLabelIndex(component)}`;
	}

	private restoreHardwareCursorAfterRawWrite(): void {
		const screenRow = Math.max(
			0,
			Math.min(this.terminal.rows - 1, this.hardwareCursorRow - this.previousViewportTop),
		);
		const screenCol = Math.max(0, this.hardwareCursorCol);
		this.terminal.write(`\x1b[${screenRow + 1};${screenCol + 1}H`);
		if (this.showHardwareCursor) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
