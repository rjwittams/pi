import type { Component } from "./tui.ts";

/** Zero-based terminal-cell rectangle. Bounds may extend outside the viewport. */
export interface SurfaceRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SurfaceGeometry {
	/** Allocated rectangle before clipping. */
	bounds: SurfaceRect;
	/** Visible intersection with containing viewports. Empty when off-screen. */
	clip: SurfaceRect;
	/** Opaque overlays above this surface, intersected with clip, in terminal cells.
	 * Includes their text chrome. Rectangles may overlap; absent means uncovered.
	 */
	occlusions?: readonly SurfaceRect[];
	/** Content row displayed at the top of bounds (for cursor-scrolled leaves). */
	contentOffset: number;
}

export interface SurfaceOptions {
	/** Request normalized mouse input in regular mode for this registration's lifetime. */
	mouse?: boolean;
}

/** Renderer damage to external graphics. Image loss also implies placement loss. */
export type SurfaceGraphicsInvalidation = "none" | "placements" | "images";

export interface SurfaceRenderContext {
	geometry: SurfaceGeometry | undefined;
	/** Changes when geometry or graphics validity changes, not on idle renders. */
	revision: number;
	graphicsInvalidation: SurfaceGraphicsInvalidation;
	/** Final cleanup delivery before the handle becomes unusable. */
	disposed: boolean;
	/**
	 * Write complete graphics/control sequences, preserving pi's cursor.
	 * Only valid synchronously inside this callback. Returns false for a stale context.
	 * Callers must preserve the text grid, terminal modes, and cursor save slot.
	 */
	write(data: string): boolean;
}

interface SurfaceHost {
	requestRender(): void;
	createWriter(): (data: string) => boolean;
	cleanup(callback: () => void): void;
}

/** Geometry of a child in its parent's last render, in parent-local cells. */
export interface RenderedChild {
	component: Component;
	bounds: SurfaceRect;
}

export interface RenderedSurfaceChild extends RenderedChild {
	children: readonly RenderedSurfaceChild[];
}

/** Capture nested geometry alongside cached render lines, before another width is rendered. */
export function captureRenderedChildren(component: Component): RenderedSurfaceChild[] {
	return (component.getRenderedChildren?.() ?? []).map((child) => ({
		component: child.component,
		bounds: { ...child.bounds },
		children: captureRenderedChildren(child.component),
	}));
}

/** An explicit geometry subscription, valid until disposed or its renderer stops. */
export interface SurfaceHandle {
	/** Undefined before the first committed render, while absent, or after disposal. */
	getGeometry(): SurfaceGeometry | undefined;
	/** Initial delivery is synchronous; subsequent delivery follows terminal writes. */
	onGeometryChange(listener: (geometry: SurfaceGeometry | undefined) => void): () => void;
	/** Runs after each committed render, and once for disposal cleanup. */
	onRender(listener: (context: SurfaceRenderContext) => void): () => void;
	/** Schedule a render when asynchronous external content becomes available. */
	requestRender(): void;
	/** Release registration and listeners. Safe to call more than once. */
	dispose(): void;
}

export function intersectSurfaceRects(a: SurfaceRect, b: SurfaceRect): SurfaceRect {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
		height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
	};
}

/** Walk recorded render output without rendering components a second time. */
export function collectSurfaceGeometry(
	geometries: Map<Component, SurfaceGeometry>,
	component: Component,
	bounds: SurfaceRect,
	clip: SurfaceRect,
	contentOffset = 0,
	children: readonly RenderedSurfaceChild[] = captureRenderedChildren(component),
): void {
	geometries.set(component, { bounds, clip, contentOffset });
	for (const child of children) {
		const childBounds = {
			...child.bounds,
			x: bounds.x + child.bounds.x,
			y: bounds.y + child.bounds.y - contentOffset,
		};
		collectSurfaceGeometry(
			geometries,
			child.component,
			childBounds,
			intersectSurfaceRects(clip, childBounds),
			0,
			child.children,
		);
	}
}

function copyGeometry(geometry: SurfaceGeometry | undefined): SurfaceGeometry | undefined {
	return geometry
		? {
				bounds: { ...geometry.bounds },
				clip: { ...geometry.clip },
				contentOffset: geometry.contentOffset,
				...(geometry.occlusions ? { occlusions: geometry.occlusions.map((rect) => ({ ...rect })) } : {}),
			}
		: undefined;
}

function sameRect(a: SurfaceRect, b: SurfaceRect): boolean {
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

class SurfaceRegistration implements SurfaceHandle {
	private geometry: SurfaceGeometry | undefined;
	private readonly listeners = new Set<(geometry: SurfaceGeometry | undefined) => void>();
	private state: "active" | "disposing" | "disposed" = "active";
	private revision = 0;
	private readonly renderListeners = new Set<(context: SurfaceRenderContext) => void>();
	private needsInitialRender = true;
	private readonly host: SurfaceHost;
	private readonly unregister: () => void;

	constructor(unregister: () => void, host: SurfaceHost) {
		this.unregister = unregister;
		this.host = host;
	}

	getGeometry(): SurfaceGeometry | undefined {
		return copyGeometry(this.geometry);
	}

	onGeometryChange(listener: (geometry: SurfaceGeometry | undefined) => void): () => void {
		if (this.state === "active") this.listeners.add(listener);
		listener(this.getGeometry());
		return () => {
			this.listeners.delete(listener);
		};
	}

	onRender(listener: (context: SurfaceRenderContext) => void): () => void {
		if (this.state === "active") {
			this.renderListeners.add(listener);
			this.needsInitialRender = true;
			this.host.requestRender();
		}
		return () => {
			this.renderListeners.delete(listener);
		};
	}

	requestRender(): void {
		if (this.state === "active") this.host.requestRender();
	}

	update(geometry: SurfaceGeometry | undefined): (() => void) | undefined {
		if (this.state !== "active") return undefined;
		const previous = this.geometry;
		if (previous === undefined && geometry === undefined) return undefined;
		if (
			previous &&
			geometry &&
			sameRect(previous.bounds, geometry.bounds) &&
			sameRect(previous.clip, geometry.clip) &&
			(previous.occlusions?.length ?? 0) === (geometry.occlusions?.length ?? 0) &&
			(previous.occlusions ?? []).every((rect, index) => sameRect(rect, geometry.occlusions![index])) &&
			previous.contentOffset === geometry.contentOffset
		)
			return undefined;
		this.geometry = copyGeometry(geometry);
		this.revision++;
		return () => {
			if (this.state !== "active") return;
			for (const listener of [...this.listeners]) {
				if (!this.listeners.has(listener)) continue;
				try {
					listener(this.getGeometry());
				} catch {
					/* One listener must not prevent other subscriptions from updating. */
				}
			}
		};
	}

	prepareRender(invalidation: SurfaceGraphicsInvalidation): () => void {
		const graphicsInvalidation = this.needsInitialRender ? "images" : invalidation;
		this.needsInitialRender = false;
		if (graphicsInvalidation !== "none") this.revision++;
		const revision = this.revision;
		return () => {
			if (this.state === "active" && this.revision === revision) this.deliverRender(graphicsInvalidation, false);
		};
	}

	private deliverRender(graphicsInvalidation: SurfaceGraphicsInvalidation, disposed: boolean): void {
		const revision = this.revision;
		const state = this.state;
		for (const listener of [...this.renderListeners]) {
			if (this.state !== state || this.revision !== revision) break;
			if (!this.renderListeners.has(listener)) continue;
			let open = true;
			const write = this.host.createWriter();
			try {
				listener({
					geometry: this.getGeometry(),
					revision,
					graphicsInvalidation,
					disposed,
					write: (data) => open && this.state === state && this.revision === revision && write(data),
				});
			} catch {
				// One consumer must not interrupt other surfaces or renderer cleanup.
			} finally {
				open = false;
			}
		}
	}

	dispose(): void {
		if (this.state !== "active") return;
		this.state = "disposing";
		this.revision++;
		this.unregister();
		this.geometry = undefined;
		this.listeners.clear();
		this.host.cleanup(() => {
			this.deliverRender("none", true);
			this.renderListeners.clear();
			this.state = "disposed";
		});
	}
}

/** Renderer-owned registry. Publish every snapshot before invoking user callbacks. */
export class SurfaceRegistry {
	private readonly registrations = new Map<SurfaceRegistration, Component>();
	private geometries = new Map<Component, SurfaceGeometry>();
	private readonly host: SurfaceHost;

	constructor(host: SurfaceHost) {
		this.host = host;
	}

	get active(): boolean {
		return this.registrations.size > 0;
	}

	has(component: Component): boolean {
		return [...this.registrations.values()].includes(component);
	}

	track(component: Component, onDispose?: () => void): SurfaceHandle {
		const registration = new SurfaceRegistration(() => {
			this.registrations.delete(registration);
			if (!this.active) this.geometries.clear();
			onDispose?.();
		}, this.host);
		this.registrations.set(registration, component);
		registration.update(this.geometries.get(component));
		return registration;
	}

	commit(
		geometries: Map<Component, SurfaceGeometry>,
		invalidation: SurfaceGraphicsInvalidation = "none",
		render = true,
	): void {
		this.geometries = geometries;
		const notifications: (() => void)[] = [];
		const renders: (() => void)[] = [];
		for (const [registration, component] of this.registrations) {
			const notify = registration.update(geometries.get(component));
			if (notify) notifications.push(notify);
			if (render) renders.push(registration.prepareRender(invalidation));
		}
		for (const notify of notifications) notify();
		for (const notify of renders) notify();
	}

	stop(): void {
		this.commit(new Map(), "none", false);
		for (const registration of this.registrations.keys()) registration.dispose();
	}
}
