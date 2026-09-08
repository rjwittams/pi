import type { Component, OverlayHandle, OverlayOptions, SurfaceHandle, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "./theme/theme.ts";

type CustomComponent = Component & { dispose?(): void };

export interface CustomUIOptions {
	overlay?: boolean;
	overlayOptions?: OverlayOptions | (() => OverlayOptions);
	onHandle?: (handle: OverlayHandle) => void;
}

/** Own one custom prompt, including resources created before an async factory completes. */
export function createCustomUI<T>(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	factory: (
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: T) => void,
	) => CustomComponent | Promise<CustomComponent>,
	options: CustomUIOptions | undefined,
	mount: (component: Component) => void,
	unmount: () => void,
): { result: Promise<T>; cancel(): void } {
	let component: CustomComponent | undefined;
	let overlay: OverlayHandle | undefined;
	let mounted = false;
	let closed = false;
	let outcome: { value: T } | { error: Error } | undefined;
	const surfaces = new Set<SurfaceHandle>();
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const result = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	const owner = tui.trackSurface({ render: () => [], invalidate: () => {} });
	const disposeComponent = (target: CustomComponent | undefined) => {
		try {
			target?.dispose?.();
		} catch {
			/* Continue host cleanup. */
		}
	};
	owner.onRender((frame) => {
		if (!frame.disposed) return;
		closed = true;
		for (const surface of surfaces) surface.dispose();
		surfaces.clear();
		overlay?.hide();
		if (mounted && !options?.overlay) unmount();
		disposeComponent(component);
		component = undefined;
		if (outcome && "value" in outcome) resolve(outcome.value);
		else reject(outcome?.error ?? new Error("Custom UI closed because its renderer stopped"));
	});
	const finish = (next: NonNullable<typeof outcome>) => {
		if (closed) return;
		closed = true;
		outcome = next;
		owner.dispose();
	};
	const scopedTui = new Proxy(tui, {
		get: (target, property) => {
			if (property === "trackSurface")
				return (child: Component, surfaceOptions?: Parameters<TUI["trackSurface"]>[1]) => {
					if (closed) throw new Error("Custom UI has been disposed");
					const surface = target.trackSurface(child, surfaceOptions);
					surfaces.add(surface);
					return surface;
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	void Promise.resolve()
		.then(() => {
			if (closed) return undefined;
			return factory(scopedTui, theme, keybindings, (value) => finish({ value }));
		})
		.then((created) => {
			if (closed) {
				disposeComponent(created);
				return;
			}
			if (!created) throw new Error("Custom UI factory returned no component");
			component = created;
			if (options?.overlay) {
				const configured =
					typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
				const width = "width" in component && typeof component.width === "number" ? component.width : undefined;
				overlay = tui.showOverlay(component, configured ?? (width ? { width } : undefined));
				overlay.onDispose(() => finish({ error: new Error("Custom UI overlay was removed") }));
				options.onHandle?.(overlay);
			} else {
				mounted = true;
				mount(component);
			}
		})
		.catch((error: unknown) => finish({ error: error instanceof Error ? error : new Error(String(error)) }));
	return { result, cancel: () => finish({ error: new Error("Custom UI was cancelled by its host") }) };
}
