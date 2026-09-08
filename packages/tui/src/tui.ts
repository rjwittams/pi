/**
 * Minimal TUI implementation with differential rendering
 */

import { performance } from "node:perf_hooks";
import { occludeImageRow } from "./image-occlusion.ts";
import { splitImageRow } from "./image-row.ts";
import { getKeybindings } from "./keybindings.ts";
import { isKeyRelease, matchesKey } from "./keys.ts";
import { getLayoutNode } from "./layout-node.ts";
import {
	collectSurfaceGeometry,
	intersectSurfaceRects,
	type RenderedChild,
	type SurfaceGeometry,
	type SurfaceGraphicsInvalidation,
	type SurfaceHandle,
	type SurfaceOptions,
	SurfaceRegistry,
} from "./surface.ts";
import type { Terminal } from "./terminal.ts";
import {
	isOsc11BackgroundColorResponse,
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
} from "./terminal-colors.ts";
import { getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.ts";

/**
 * Component interface - all components must implement this
 */
export interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

export interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
	button: number;
}

export type TuiMouseEventType = "press" | "release" | "move" | "drag" | "click" | "wheel";
export type TuiMouseButton = "left" | "middle" | "right" | "none";

/** Normalized cell-based mouse event. Coordinates are zero-based. */
export interface TuiMouseEvent {
	type: TuiMouseEventType;
	button: TuiMouseButton;
	/** Coordinates local to the receiving component. */
	x: number;
	y: number;
	/** Absolute terminal coordinates. */
	screenX: number;
	screenY: number;
	/** Current component bounds. */
	width: number;
	height: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	/** Logical lines. Negative values scroll up. */
	wheelDelta?: number;
	/** Physical vertical wheel steps, before viewport acceleration. */
	wheelSteps?: number;
	/** Consecutive click count when type is click. */
	clickCount?: number;
}

export interface TuiMouseEventResult {
	/** Stop propagation and suppress renderer-level fallback behavior. */
	handled?: boolean;
	/** Route subsequent drag/release events to this component. Implies handled. */
	capture?: boolean;
	/** Give keyboard focus to this component. Implies handled. */
	focus?: boolean;
	/**
	 * Explicitly request or suppress a render. Move and release default to false;
	 * press, click, drag, and wheel default to true.
	 */
	render?: boolean;
}

/** Internal target metadata used by containers and alternate-screen dispatch. */
export interface TuiMouseDispatchTarget {
	component: Component;
	originX: number;
	originY: number;
	width: number;
	height: number;
	/** Outermost dispatching wrapper, for legacy wrappers without child geometry. */
	owner?: { component: Component; originX: number; originY: number };
	/** Whether this target has been found in committed geometry. */
	measured?: boolean;
	/** A registration was disposed while its handler was running. */
	cancelled?: boolean;
}

/** Result of dispatching to a concrete component. */
export interface TuiMouseDispatchResult extends TuiMouseEventResult {
	handled: true;
	target: TuiMouseDispatchTarget;
	/** Keyboard focus target, which may be a delegating parent container. */
	focusTarget?: Component;
}

/**
 * Dispatch an event to a component and retain the exact target and coordinate
 * transform. Containers use this when forwarding events to nested children.
 */
export function dispatchMouseEvent(component: Component, event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
	const result = component.handleMouse?.(event);
	if (!result) return undefined;
	if ("target" in result) {
		const dispatched = result as TuiMouseDispatchResult;
		return {
			...dispatched,
			target: {
				...dispatched.target,
				owner: { component, originX: event.screenX - event.x, originY: event.screenY - event.y },
			},
		};
	}
	if (!result.handled && !result.capture && !result.focus) return undefined;
	return {
		...result,
		handled: true,
		...(result.focus ? { focusTarget: component } : {}),
		target: {
			component,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}

/** Recreate local coordinates for a previously dispatched mouse target. */
export function retargetMouseEvent(event: TuiMouseEvent, target: TuiMouseDispatchTarget): TuiMouseEvent {
	return {
		...event,
		x: event.screenX - target.originX,
		y: event.screenY - target.originY,
		width: target.width,
		height: target.height,
	};
}

export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/** Child positions recorded by the last render; must not trigger rendering. */
	getRenderedChildren?(): readonly RenderedChild[];

	/** Optional handler for keyboard input when component has focus. */
	handleInput?(data: string): void;

	/** Optional normalized mouse handler. */
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	/** Release component-owned pressed state when the renderer cancels a mouse gesture. */
	handleMouseCancel?(): void;

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

export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TuiInputListener = (data: string) => TuiInputListenerResult;
type PendingOsc11BackgroundQuery = {
	settled: boolean;
	resolve: ((rgb: RgbColor | undefined) => void) | undefined;
	timer: NodeJS.Timeout | undefined;
};

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

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Allocated height in rows or percentage of terminal height; pads or clips content. */
	height?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
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

/** Last rendered terminal-relative overlay rectangle. */
export interface OverlayBounds {
	row: number;
	col: number;
	width: number;
	height: number;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Called once when permanently removed, including through TUI.hideOverlay(). */
	onDispose(callback: () => void): () => void;
	/** Merge layout options and schedule a render. Undefined fields restore their defaults. */
	updateOptions(options: Partial<OverlayOptions>): void;
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/** Focus this overlay and bring it to the visual front */
	focus(): void;
	/** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
	unfocus(options?: OverlayUnfocusOptions): void;
	/** Check if this overlay currently has focus */
	isFocused(): boolean;
	/** Get the most recent rendered bounds for a visible overlay. */
	getBounds(): OverlayBounds | undefined;
}

type OverlayStackEntry = {
	disposeListeners: Set<() => void>;
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
	bounds?: OverlayBounds;
};

type RenderedOverlayLayout = {
	entry: OverlayStackEntry;
	row: number;
	col: number;
	width: number;
	height: number;
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
	protected renderedChildren: RenderedChild[] = [];

	getRenderedChildren(): readonly RenderedChild[] {
		return this.renderedChildren;
	}

	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.y < 0 || event.y >= event.height) return undefined;
		const mouseChildren =
			this.mouseLayout?.width === event.width
				? this.mouseLayout.children
				: this.children.map((component) => ({ component, height: component.render(event.width).length }));
		let childY = 0;
		for (const { component: child, height: childHeight } of mouseChildren) {
			if (event.y >= childY && event.y < childY + childHeight) {
				const result = dispatchMouseEvent(child, {
					...event,
					y: event.y - childY,
					height: childHeight,
				});
				if (result?.focus && (this as Component).handleInput) return { ...result, focusTarget: this };
				return result;
			}
			childY += childHeight;
		}
		return undefined;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		this.renderedChildren = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			this.renderedChildren.push({
				component: child,
				bounds: { x: 0, y: lines.length, width, height: childLines.length },
			});
			mouseChildren.push({ component: child, height: childLines.length });
			for (const line of childLines) {
				lines.push(line);
			}
		}
		this.mouseLayout = { width, children: mouseChildren };
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** Composite overlay content into a terminal line at a fixed column. */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

export type TuiMode = "regular" | "fullscreen";

export interface TuiStopOptions {
	/** Leave renderer output in place for another TUI taking over the same terminal. */
	preserveScreen?: boolean;
}

export interface TUI extends Component {
	readonly mode: TuiMode;
	/** True while the renderer owns the terminal for interactive output. */
	readonly isRunning: boolean;
	children: Component[];
	terminal: Terminal;
	onDebug?: () => void;
	readonly fullRedraws: number;
	/** Observe committed geometry; dispose the handle when its owner is removed. */
	trackSurface(component: Component, options?: SurfaceOptions): SurfaceHandle;
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	setFocus(component: Component | null): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	hideOverlay(): void;
	hasOverlay(): boolean;
	start(): void;
	stop(options?: TuiStopOptions): void;
	renderNow(force?: boolean): void;
	requestRender(force?: boolean): void;
	addInputListener(listener: TuiInputListener): () => void;
	removeInputListener(listener: TuiInputListener): void;
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void;
	setTerminalColorSchemeNotifications(enabled: boolean): void;
	queryTerminalBackgroundColor(options: { timeoutMs: number }): Promise<RgbColor | undefined>;
	queryTerminalColorScheme(options: { timeoutMs: number }): Promise<TerminalColorScheme | undefined>;
}

export const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

export interface ViewportTUI extends TUI {
	readonly [VIEWPORT_TUI]: true;
	setLayoutRoot(component: Component | undefined): void;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

export abstract class TuiBase extends Container implements TUI {
	get isRunning(): boolean {
		return this.surfaceOutputActive && !this.stopped;
	}

	protected mouseCapture?: TuiMouseDispatchTarget;
	protected mousePressTarget?: TuiMouseDispatchTarget;
	protected mousePressPoint?: { x: number; y: number };
	protected mousePressMoved = false;
	private mousePressButton: TuiMouseButton = "none";
	protected lastComponentClick?: {
		timestamp: number;
		count: number;
		component: Component;
		x: number;
		y: number;
	};

	protected clearComponentMouseGesture(cancel = true): void {
		const target = this.mouseCapture ?? this.mousePressTarget;
		this.mouseCapture = undefined;
		this.mousePressTarget = undefined;
		this.mousePressPoint = undefined;
		this.mousePressMoved = false;
		this.mousePressButton = "none";
		if (cancel && target?.component.handleMouseCancel) {
			try {
				target.component.handleMouseCancel();
			} catch {
				// Consumer cleanup must not prevent renderer or terminal cleanup.
			} finally {
				this.requestRender();
			}
		}
	}

	protected decodeMouseButton(button: number): TuiMouseButton {
		switch (button & 3) {
			case 0:
				return "left";
			case 1:
				return "middle";
			case 2:
				return "right";
			default:
				return "none";
		}
	}

	protected createMouseEvent(
		type: TuiMouseEvent["type"],
		button: number,
		x: number,
		y: number,
		extra: Partial<Pick<TuiMouseEvent, "wheelDelta" | "wheelSteps" | "clickCount">> = {},
	): TuiMouseEvent {
		return {
			type,
			button: type === "wheel" ? "none" : this.decodeMouseButton(button),
			x,
			y,
			screenX: x,
			screenY: y,
			width: Math.max(1, this.terminal.columns),
			height: Math.max(1, this.terminal.rows),
			shift: (button & 4) !== 0,
			alt: (button & 8) !== 0,
			ctrl: (button & 16) !== 0,
			...(extra.wheelDelta === undefined ? {} : { wheelDelta: extra.wheelDelta }),
			...(extra.wheelSteps === undefined ? {} : { wheelSteps: extra.wheelSteps }),
			...(extra.clickCount === undefined ? {} : { clickCount: extra.clickCount }),
		};
	}

	protected applyMouseDispatchResult(event: TuiMouseEvent, result: TuiMouseDispatchResult): boolean {
		if (!this.refreshMouseTarget(result.target)) return result.render ?? true;
		const focusTarget = this.resolveMouseFocusTarget(result.focusTarget ?? result.target.component);
		const focusChanged = result.focus === true && this.getFocusedComponent() !== focusTarget;
		const overlay = this.overlayStack.find((entry) => entry.component === focusTarget);
		if (focusChanged && this.surfaces.has(result.target.component) && (!overlay || overlay.options?.nonCapturing)) {
			this.surfaceMouseFocus = {
				target: focusTarget,
				previous: this.surfaceMouseFocus?.previous ?? this.getFocusedComponent(),
				mouseTarget: result.target,
			};
		}
		if (result.focus) this.setFocus(focusTarget);
		if (result.capture && !this.mouseCapture) this.mouseCapture = result.target;
		return (
			result.render ??
			(focusChanged ||
				event.type === "press" ||
				event.type === "click" ||
				event.type === "drag" ||
				event.type === "wheel")
		);
	}

	protected dispatchMouseToTarget(
		event: TuiMouseEvent,
		target: TuiMouseDispatchTarget,
	): TuiMouseDispatchResult | undefined {
		if (!this.refreshMouseTarget(target)) return undefined;
		const result = this.dispatchComponentMouseEvent(target.component, retargetMouseEvent(event, target));
		if (result?.target.cancelled) target.cancelled = true;
		return result ? { ...result, target } : undefined;
	}

	protected getComponentClickCount(target: TuiMouseDispatchTarget, x: number, y: number): number {
		const now = Date.now();
		const previous = this.lastComponentClick;
		const count =
			previous &&
			now - previous.timestamp <= 500 &&
			previous.component === target.component &&
			previous.x === x &&
			previous.y === y
				? (previous.count % 3) + 1
				: 1;
		this.lastComponentClick = { timestamp: now, count, component: target.component, x, y };
		return count;
	}

	protected parseWheelEvent(data: string): WheelEvent | undefined {
		const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
		if (sgr) {
			const button = Number.parseInt(sgr[1], 10);
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: Number.parseInt(sgr[2], 10) - 1,
				y: Number.parseInt(sgr[3], 10) - 1,
				button,
			};
		}
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const button = data.charCodeAt(3) - 32;
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: data.charCodeAt(4) - 33,
				y: data.charCodeAt(5) - 33,
				button,
			};
		}
		return undefined;
	}

	protected parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		if (!match) return undefined;
		return {
			button: Number.parseInt(match[1], 10),
			x: Number.parseInt(match[2], 10) - 1,
			y: Number.parseInt(match[3], 10) - 1,
			release: match[4] === "m",
		};
	}

	protected isMouseSequence(data: string): boolean {
		return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
	}

	abstract readonly mode: TuiMode;
	public terminal: Terminal;
	private focusedComponent: Component | null = null;
	private readonly surfaces = new SurfaceRegistry({
		requestRender: () => this.requestRender(),
		createWriter: () => {
			const epoch = this.surfaceOutputEpoch;
			return (data) => epoch === this.surfaceOutputEpoch && this.writeSurfaceOutput(data);
		},
		cleanup: (callback) => {
			if (this.renderingText) this.surfaceCleanups.push(callback);
			else callback();
		},
	});
	private committingFrame = false;
	private renderingText = false;
	private surfaceOutputActive = false;
	private surfaceOutputEpoch = 0;
	private surfaceCleanups: (() => void)[] = [];
	private surfaceGraphicsInvalidation: SurfaceGraphicsInvalidation = "images";
	private surfaceMouseRequests = 0;
	private surfaceDisposalEpoch = 0;
	private readonly surfaceDisposedAt = new WeakMap<Component, number>();
	protected frameGeometries = new Map<Component, SurfaceGeometry>();
	private surfaceMouseFocus?: { target: Component; previous: Component | null; mouseTarget: TuiMouseDispatchTarget };

	trackSurface(component: Component, options: SurfaceOptions = {}): SurfaceHandle {
		const mouse = options.mouse === true;
		if (mouse) this.surfaceMouseRequests++;
		const handle = this.surfaces.track(component, () => {
			if (mouse) this.surfaceMouseRequests--;
			if (!this.surfaces.has(component)) {
				this.surfaceDisposedAt.set(component, ++this.surfaceDisposalEpoch);
				if (this.surfaceMouseFocus?.mouseTarget.component === component) this.releaseSurfaceMouseFocus();
				if ((this.mouseCapture ?? this.mousePressTarget)?.component === component)
					this.clearComponentMouseGesture();
			}
			this.updateSurfaceMouseMode();
			this.requestRender();
		});
		this.updateSurfaceMouseMode();
		this.requestRender();
		return handle;
	}

	protected updateSurfaceMouseMode(): void {}

	protected get surfaceMouseRequested(): boolean {
		return this.surfaceMouseRequests > 0;
	}

	private isOverlayComponent(component: Component): boolean {
		return this.overlayStack.some((entry) => entry.component === component);
	}

	protected dispatchComponentMouseEvent(
		component: Component,
		event: TuiMouseEvent,
	): TuiMouseDispatchResult | undefined {
		const epoch = this.surfaceDisposalEpoch;
		const result = dispatchMouseEvent(component, event);
		if (result && (this.surfaceDisposedAt.get(result.target.component) ?? 0) > epoch) result.target.cancelled = true;
		return result;
	}

	/** Refresh a captured target without using requested layout or rendering again. */
	protected refreshMouseTarget(target: TuiMouseDispatchTarget): boolean {
		if (this.stopped || target.cancelled) return false;
		const geometry = this.frameGeometries.get(target.component);
		if (geometry) target.measured = true;
		if (target.measured || this.surfaces.has(target.component)) {
			if (!geometry || geometry.clip.width <= 0 || geometry.clip.height <= 0) return false;
			if (!this.isComponentMounted(target.component)) return false;
			target.originX = geometry.bounds.x;
			target.originY = geometry.bounds.y - geometry.contentOffset;
			target.width = geometry.bounds.width;
			target.height = geometry.bounds.height;
			return true;
		}
		const owner = target.owner;
		if (!this.isComponentMounted(target.component) && (!owner || !this.isComponentMounted(owner.component)))
			return false;
		const ownerGeometry = owner && this.frameGeometries.get(owner.component);
		if (owner && ownerGeometry) {
			if (ownerGeometry.clip.width <= 0 || ownerGeometry.clip.height <= 0) return false;
			const originY = ownerGeometry.bounds.y - ownerGeometry.contentOffset;
			target.originX += ownerGeometry.bounds.x - owner.originX;
			target.originY += originY - owner.originY;
			owner.originX = ownerGeometry.bounds.x;
			owner.originY = originY;
		}
		return true;
	}

	private reconcileComponentMouseState(): void {
		const target = this.mouseCapture ?? this.mousePressTarget;
		if (target && !this.refreshMouseTarget(target)) {
			this.lastComponentClick = undefined;
			this.clearComponentMouseGesture();
		}
		if (this.surfaceMouseFocus && !this.refreshMouseTarget(this.surfaceMouseFocus.mouseTarget)) {
			this.releaseSurfaceMouseFocus();
		}
	}

	private releaseSurfaceMouseFocus(): void {
		const focus = this.surfaceMouseFocus;
		if (!focus) return;
		this.surfaceMouseFocus = undefined;
		this.clearComponentMouseGesture();
		const previous = focus.previous && this.isComponentMounted(focus.previous) ? focus.previous : null;
		// A modal overlay may currently own focus and still refer to the inline target.
		for (const overlay of this.overlayStack) {
			if (overlay.component === focus.target) this.clearOverlayFocusRestoreFor(overlay);
			if (overlay.preFocus === focus.target) overlay.preFocus = previous;
		}
		if (this.focusedComponent === focus.target) {
			this.setFocus(this.getTopmostVisibleOverlay()?.component ?? previous);
			this.requestRender();
		}
	}

	protected beginComponentMouseGesture(event: TuiMouseEvent, result: TuiMouseDispatchResult): void {
		if (!this.refreshMouseTarget(result.target)) {
			this.mousePressTarget = result.target;
			this.clearComponentMouseGesture();
			return;
		}
		this.mousePressTarget = result.target;
		this.mousePressPoint = { x: event.screenX, y: event.screenY };
		this.mousePressMoved = false;
		this.mousePressButton = event.button;
	}

	/** Handle an existing press before renderer-specific selection/scrollbar fallbacks. */
	protected dispatchCapturedMouseEvent(event: TuiMouseEvent): boolean {
		const target = this.mouseCapture ?? this.mousePressTarget;
		if (!target) return false;
		if (!this.refreshMouseTarget(target)) {
			this.clearComponentMouseGesture();
			return event.type !== "press";
		}
		// A new press ends an orphaned gesture (for example, a release lost outside the window).
		if (event.type === "press") {
			this.clearComponentMouseGesture();
			return false;
		}
		if (event.type === "release" && event.button === "none") event = { ...event, button: this.mousePressButton };
		if (
			this.mousePressPoint &&
			(event.screenX !== this.mousePressPoint.x || event.screenY !== this.mousePressPoint.y)
		) {
			this.mousePressMoved = true;
			this.lastComponentClick = undefined;
		}
		let render = false;
		const result = this.dispatchMouseToTarget(event, target);
		if (result) render = this.applyMouseDispatchResult(event, result);
		if (event.type === "release") {
			if (
				!this.mousePressMoved &&
				this.mousePressPoint?.x === event.screenX &&
				this.mousePressPoint.y === event.screenY
			) {
				const click = {
					...event,
					type: "click" as const,
					clickCount: this.getComponentClickCount(target, event.screenX, event.screenY),
				};
				const clicked = this.dispatchMouseToTarget(click, target);
				if (clicked) render = this.applyMouseDispatchResult(click, clicked) || render;
			}
			this.clearComponentMouseGesture(false);
		}
		if (render) this.requestRender();
		return true;
	}

	protected releaseSurfaceFocusOutside(event: TuiMouseEvent): void {
		const focus = this.surfaceMouseFocus;
		if (event.type !== "press" || !focus || this.focusedComponent !== focus.target) return;
		const clip = this.frameGeometries.get(focus.mouseTarget.component)?.clip;
		if (
			!clip ||
			event.screenX < clip.x ||
			event.screenX >= clip.x + clip.width ||
			event.screenY < clip.y ||
			event.screenY >= clip.y + clip.height
		) {
			this.releaseSurfaceMouseFocus();
		}
	}

	protected collectFrameSurfaces(): Map<Component, SurfaceGeometry> {
		return new Map();
	}

	protected get hasSurfaceSubscriptions(): boolean {
		return this.surfaces.active || !!this.mouseCapture || !!this.mousePressTarget || !!this.surfaceMouseFocus;
	}

	protected invalidateSurfaceGraphics(invalidation: SurfaceGraphicsInvalidation): void {
		if (invalidation === "images" || this.surfaceGraphicsInvalidation === "none") {
			this.surfaceGraphicsInvalidation = invalidation;
		}
	}

	private writeSurfaceOutput(data: string): boolean {
		if (!this.surfaceOutputActive || this.renderingText) return false;
		if (!data) return true;
		const ownsUpdate = !this.committingFrame;
		this.terminal.write(ownsUpdate ? "\x1b[?2026h\x1b7" : "\x1b7");
		try {
			this.terminal.write(data);
		} finally {
			this.terminal.write(ownsUpdate ? "\x1b8\x1b[?2026l" : "\x1b8");
		}
		return true;
	}

	private flushSurfaceCleanups(): void {
		const callbacks = this.surfaceCleanups;
		this.surfaceCleanups = [];
		for (const callback of callbacks) callback();
	}

	private renderFrame(): void {
		if (this.stopped) return;
		if (this.committingFrame) {
			this.requestRender();
			return;
		}
		this.committingFrame = true;
		try {
			this.terminal.write("\x1b[?2026h");
			this.renderingText = true;
			try {
				this.doRender();
			} finally {
				this.renderingText = false;
			}
			this.flushSurfaceCleanups();
			const invalidation = this.surfaceGraphicsInvalidation;
			this.surfaceGraphicsInvalidation = "none";
			if (!this.hasSurfaceSubscriptions) {
				this.frameGeometries.clear();
				return;
			}
			const geometries = this.collectFrameSurfaces();
			const viewport = { x: 0, y: 0, width: this.terminal.columns, height: this.terminal.rows };
			for (const layout of this.renderedOverlayLayouts) {
				if (!this.overlayStack.includes(layout.entry) || !this.isOverlayVisible(layout.entry)) continue;
				const bounds = { x: layout.col, y: layout.row, width: layout.width, height: layout.height };
				// Layouts have the same back-to-front order as text composition and
				// mouse hit testing. The entire overlay, including chrome, is opaque.
				for (const geometry of geometries.values()) {
					const covered = intersectSurfaceRects(geometry.clip, bounds);
					if (covered.width > 0 && covered.height > 0)
						geometry.occlusions = [...(geometry.occlusions ?? []), covered];
				}
				collectSurfaceGeometry(geometries, layout.entry.component, bounds, intersectSurfaceRects(viewport, bounds));
			}
			this.frameGeometries = geometries;
			this.reconcileComponentMouseState();
			this.surfaces.commit(geometries, invalidation);
		} finally {
			try {
				this.flushSurfaceCleanups();
			} finally {
				this.committingFrame = false;
				this.terminal.write("\x1b[?2026l");
			}
		}
	}
	private inputListeners = new Set<TuiInputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private immediateRenderScheduled = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private showHardwareCursor = false;
	private clearOnShrink = false;
	protected fullRedrawCount = 0;
	protected stopped = false;
	private pendingOsc11BackgroundReplies = 0;
	private pendingOsc11BackgroundQueries: PendingOsc11BackgroundQuery[] = [];
	private terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	private terminalColorSchemeNotificationsEnabled = false;
	/** Directory for debug/crash logs. When undefined, debug logging is disabled and crash dumps fall back to the OS temp directory. */
	protected readonly logDirectory: string | undefined;

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: OverlayStackEntry[] = [];
	private renderedOverlayLayouts: RenderedOverlayLayout[] = [];

	get hasOverlayEntries(): boolean {
		return this.overlayStack.length > 0;
	}
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };

	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		super();
		this.terminal = terminal;
		this.logDirectory = logDirectory;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	/** Emit renderer output inside the frame's shared synchronized update. */
	protected abstract doRender(): void;

	protected resetRenderState(): void {}

	protected beforeTerminalStart(): void {}

	protected afterTerminalStart(): void {}

	protected beforeTerminalStop(_options: TuiStopOptions): void {}

	protected afterTerminalStop(_options: TuiStopOptions): void {}

	get fullRedraws(): number {
		return this.fullRedrawCount;
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
	 * When true, empty rows are cleared when content shrinks.
	 * When false (default), empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	getFocusedComponent(): Component | null {
		return this.focusedComponent;
	}

	setFocus(component: Component | null): void {
		if (
			this.surfaceMouseFocus &&
			component !== this.surfaceMouseFocus.target &&
			(!component || !this.isOverlayComponent(component))
		) {
			this.surfaceMouseFocus = undefined;
		}
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

	protected getMountedRoots(): readonly Component[] {
		return this.children;
	}

	private isComponentMounted(component: Component): boolean {
		return (
			component === this ||
			this.getMountedRoots().some((child) => this.containsComponent(child, component)) ||
			this.overlayStack.some(
				(entry) => this.isOverlayVisible(entry) && this.containsComponent(entry.component, component),
			)
		);
	}

	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		const node = getLayoutNode(root);
		if (node?.type === "scroll") return this.containsComponent(node.component, target);
		if (node)
			return node.entries.some(
				(entry) =>
					(entry.visible?.({ width: this.terminal.columns, height: this.terminal.rows }) ?? true) &&
					this.containsComponent(entry.component, target),
			);
		const children =
			root instanceof Container
				? root.children
				: (root.getRenderedChildren?.().map((child) => child.component) ?? []);
		return children.some((child) => this.containsComponent(child, target));
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			disposeListeners: new Set(),
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
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
			onDispose: (callback) => {
				if (this.overlayStack.includes(entry)) entry.disposeListeners.add(callback);
				else callback();
				return () => {
					entry.disposeListeners.delete(callback);
				};
			},
			updateOptions: (updates) => {
				if (!this.overlayStack.includes(entry)) return;
				entry.options = { ...entry.options, ...updates };
				if (this.focusedComponent === component && !this.isOverlayVisible(entry)) {
					this.clearOverlayFocusRestoreFor(entry);
					this.setFocus(this.getTopmostVisibleOverlay()?.component ?? entry.preFocus);
				}
				this.requestRender();
			},
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
					this.notifyOverlayDisposed(entry);
				}
			},
			setHidden: (hidden: boolean) => {
				if (!this.overlayStack.includes(entry)) return;
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!entry.options?.nonCapturing && this.isOverlayVisible(entry)) {
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
			getBounds: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry) || !entry.bounds) return undefined;
				return { ...entry.bounds };
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
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
		this.notifyOverlayDisposed(overlay);
	}

	private notifyOverlayDisposed(entry: OverlayStackEntry): void {
		const callbacks = [...entry.disposeListeners];
		entry.disposeListeners.clear();
		for (const callback of callbacks) {
			try {
				callback();
			} catch {
				/* Continue removing the remaining overlay resources. */
			}
		}
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if the focused component is a visible overlay */
	protected isOverlayFocused(): boolean {
		return this.overlayStack.some(
			(entry) => entry.component === this.focusedComponent && this.isOverlayVisible(entry),
		);
	}

	/** Keep overlay containers as keyboard focus owners when a nested control is clicked. */
	protected resolveMouseFocusTarget(component: Component): Component {
		for (let index = this.overlayStack.length - 1; index >= 0; index--) {
			const overlay = this.overlayStack[index]!;
			if (this.isOverlayVisible(overlay) && this.containsComponent(overlay.component, component)) {
				return overlay.component;
			}
		}
		return component;
	}

	/** Dispatch to the visually topmost overlay under the pointer. */
	protected dispatchMouseToOverlay(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult } {
		for (let index = this.renderedOverlayLayouts.length - 1; index >= 0; index--) {
			const layout = this.renderedOverlayLayouts[index]!;
			if (!this.overlayStack.includes(layout.entry) || !this.isOverlayVisible(layout.entry)) continue;
			if (
				event.screenX < layout.col ||
				event.screenX >= layout.col + layout.width ||
				event.screenY < layout.row ||
				event.screenY >= layout.row + layout.height
			) {
				continue;
			}
			const result = this.dispatchComponentMouseEvent(layout.entry.component, {
				...event,
				x: event.screenX - layout.col,
				y: event.screenY - layout.row,
				width: layout.width,
				height: layout.height,
			});
			return result
				? {
						hit: true,
						result: result.focus ? { ...result, focusTarget: layout.entry.component } : result,
					}
				: { hit: true };
		}
		return { hit: false };
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

	override invalidate(): void {
		for (const root of this.getMountedRoots()) root.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate();
	}

	start(): void {
		this.stopped = false;
		this.renderRequested = false;
		this.beforeTerminalStart();
		this.terminal.start(
			(data) => this.handleTerminalInput(data),
			() => this.requestRender(),
		);
		this.afterTerminalStart();
		this.surfaceOutputEpoch++;
		this.surfaceOutputActive = true;
		this.invalidateSurfaceGraphics("images");
		this.terminal.hideCursor();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031h");
		}
		this.queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: TuiInputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: TuiInputListener): void {
		this.inputListeners.delete(listener);
	}

	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.terminalColorSchemeListeners.add(listener);
		return () => {
			this.terminalColorSchemeListeners.delete(listener);
		};
	}

	setTerminalColorSchemeNotifications(enabled: boolean): void {
		if (this.terminalColorSchemeNotificationsEnabled === enabled) {
			return;
		}
		this.terminalColorSchemeNotificationsEnabled = enabled;
		if (!this.stopped) {
			this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
		}
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

	stop(options: TuiStopOptions = {}): void {
		this.stopped = true;
		this.releaseSurfaceMouseFocus();
		this.clearComponentMouseGesture();
		this.lastComponentClick = undefined;
		this.surfaces.stop();
		this.flushSurfaceCleanups();
		this.surfaceOutputActive = false;
		this.surfaceOutputEpoch++;
		this.frameGeometries.clear();
		this.cancelRenderTimer();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031l");
		}
		this.beforeTerminalStop(options);
		this.terminal.showCursor();
		this.terminal.stop();
		this.afterTerminalStop(options);
	}

	renderNow(force = false): void {
		if (force) this.resetRenderState();
		this.renderRequested = false;
		this.cancelRenderTimer();
		this.lastRenderAt = performance.now();
		this.renderFrame();
	}

	requestRender(force = false): void {
		if (force) {
			this.resetRenderState();
			this.requestImmediateRender();
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private requestImmediateRender(): void {
		this.cancelRenderTimer();
		this.renderRequested = true;
		if (this.immediateRenderScheduled) return;
		this.immediateRenderScheduled = true;
		process.nextTick(() => {
			this.immediateRenderScheduled = false;
			if (this.stopped || !this.renderRequested) return;
			// A previously queued scheduleRender() can create a timer before this
			// callback runs. User input must preempt that throttled frame.
			this.cancelRenderTimer();
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.renderFrame();
		});
	}

	private cancelRenderTimer(): void {
		if (!this.renderTimer) return;
		clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TuiBase.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.renderFrame();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	private handleTerminalInput(data: string): void {
		this.reconcileComponentMouseState();
		if (
			this.surfaceMouseFocus &&
			this.focusedComponent === this.surfaceMouseFocus.target &&
			getKeybindings().matches(data, "tui.surface.releaseFocus")
		) {
			if (!isKeyRelease(data)) this.releaseSurfaceMouseFocus();
			return;
		}
		if (this.consumeOsc11BackgroundResponse(data)) {
			return;
		}
		if (this.consumeTerminalColorSchemeReport(data)) {
			return;
		}

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

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			// Keyboard input is latency-sensitive. Avoid the throttled timer path,
			// where even setTimeout(0) can take a full 16 ms tick on Windows.
			this.requestImmediateRender();
		}
	}

	private consumeOsc11BackgroundResponse(data: string): boolean {
		if (this.pendingOsc11BackgroundReplies <= 0) {
			return false;
		}

		if (!isOsc11BackgroundColorResponse(data)) {
			return false;
		}

		const rgb = parseOsc11BackgroundColor(data);
		this.pendingOsc11BackgroundReplies -= 1;
		const query = this.pendingOsc11BackgroundQueries.shift();
		if (query && !query.settled) {
			query.settled = true;
			if (query.timer) {
				clearTimeout(query.timer);
				query.timer = undefined;
			}
			query.resolve?.(rgb);
			query.resolve = undefined;
		}
		return true;
	}

	private consumeTerminalColorSchemeReport(data: string): boolean {
		const scheme = parseTerminalColorSchemeReport(data);
		if (!scheme) {
			return false;
		}

		for (const listener of this.terminalColorSchemeListeners) {
			listener(scheme);
		}
		return true;
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
		this.invalidateSurfaceGraphics("images");
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
	): { width: number; row: number; col: number; maxHeight: number | undefined; height: number | undefined } {
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

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		const requestedHeight = parseSizeValue(opt.height, termHeight);
		const height =
			requestedHeight === undefined ? undefined : Math.max(1, Math.min(requestedHeight, maxHeight ?? availHeight));
		// Explicit allocation takes precedence over natural content height.
		const effectiveHeight = height ?? (maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight);

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

		return { width, row, col, maxHeight, height };
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
	protected compositeOverlays(
		lines: string[],
		termWidth: number,
		termHeight: number,
		imageRows: string[] = [],
	): string[] {
		if (this.overlayStack.length === 0) {
			this.renderedOverlayLayouts = [];
			return lines;
		}
		const result = [...lines];

		for (const entry of this.overlayStack) entry.bounds = undefined;

		// Pre-render all visible overlays and calculate positions
		const rendered: { entry: OverlayStackEntry; overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight, height } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);
			if (height !== undefined) {
				overlayLines = overlayLines.slice(0, height);
				while (overlayLines.length < height) overlayLines.push("");
			}

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			entry.bounds = { row, col, width, height: overlayLines.length };

			rendered.push({ entry, overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}
		this.renderedOverlayLayouts = rendered.map(({ entry, row, col, w, overlayLines }) => ({
			entry,
			row,
			col,
			width: w,
			height: overlayLines.length,
		}));

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);
		const covers = rendered.map(({ row, col, w, overlayLines }) => ({
			x: col,
			y: viewportStart + row,
			width: w,
			height: overlayLines.length,
		}));
		for (let row = 0; row < imageRows.length; row++) imageRows[row] = occludeImageRow(imageRows[row], row, covers);

		// Composite each overlay
		for (const [layer, { overlayLines, row, col, w }] of rendered.entries()) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const overlayRow = splitImageRow(overlayLines[i], col);
					if (overlayRow.images)
						imageRows[idx] =
							(imageRows[idx] ? `${imageRows[idx]}\r` : "") +
							occludeImageRow(overlayRow.images, idx, covers.slice(layer + 1));
					const truncatedOverlayLine =
						visibleWidth(overlayRow.text) > w ? sliceByColumn(overlayRow.text, 0, w, true) : overlayRow.text;
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	protected applyLineResets(lines: string[]): string[] {
		const reset = SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		return compositeTuiLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	protected extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
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

	/**
	 * Query the terminal's default background color with OSC 11 (`ESC ] 11 ; ? BEL`).
	 * @param timeoutMs Query timeout in milliseconds.
	 * @returns Promise containing the parsed RGB color, or undefined if it times out or fails to parse.
	 */
	queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined> {
		return new Promise((resolve) => {
			const query: PendingOsc11BackgroundQuery = {
				settled: false,
				resolve,
				timer: undefined,
			};

			query.timer = setTimeout(() => {
				if (query.settled) {
					return;
				}
				query.settled = true;
				query.timer = undefined;
				query.resolve?.(undefined);
				query.resolve = undefined;
			}, timeoutMs);
			this.pendingOsc11BackgroundQueries.push(query);
			this.pendingOsc11BackgroundReplies += 1;
			this.terminal.write("\x1b]11;?\x07");
		});
	}

	/**
	 * Query the terminal's color-scheme preference with DSR (`CSI ? 996 n`).
	 * Terminals that support the color palette notification protocol reply with
	 * `CSI ? 997 ; 1 n` for dark or `CSI ? 997 ; 2 n` for light.
	 */
	queryTerminalColorScheme({ timeoutMs }: { timeoutMs: number }): Promise<TerminalColorScheme | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let unsubscribe: () => void = () => {};
			const settle = (scheme: TerminalColorScheme | undefined) => {
				if (settled) return;
				settled = true;
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
				unsubscribe();
				resolve(scheme);
			};

			unsubscribe = this.onTerminalColorSchemeChange(settle);
			timer = setTimeout(() => settle(undefined), timeoutMs);
			this.terminal.write("\x1b[?996n");
		});
	}
}
