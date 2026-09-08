import type { Component, SurfaceHandle, SurfaceOptions, TUI } from "@earendil-works/pi-tui";
import type { MessageRendererUI } from "../../../core/extensions/types.ts";

/** Disposed by the host's post-render or final surface callback, outside text rendering. */
export class MessageRenderScope implements MessageRendererUI {
	private readonly tui: TUI;
	private readonly surfaces = new Set<SurfaceHandle>();
	private readonly callbacks = new Set<() => void>();
	private disposed = false;

	constructor(tui: TUI) {
		this.tui = tui;
	}

	trackSurface(component: Component, options?: SurfaceOptions): SurfaceHandle {
		if (this.disposed) throw new Error("Message renderer has been disposed");
		const handle = this.tui.trackSurface(component, options);
		this.surfaces.add(handle);
		return handle;
	}

	onDispose(callback: () => void): () => void {
		if (this.disposed) {
			callback();
			return () => {};
		}
		this.callbacks.add(callback);
		return () => this.callbacks.delete(callback);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const surface of this.surfaces) surface.dispose();
		this.surfaces.clear();
		for (const callback of this.callbacks) {
			try {
				callback();
			} catch {
				// One extension cleanup must not prevent the remaining resources from closing.
			}
		}
		this.callbacks.clear();
	}
}
