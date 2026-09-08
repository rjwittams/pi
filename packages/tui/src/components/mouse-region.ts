import type { RenderedChild } from "../surface.ts";
import {
	type Component,
	dispatchMouseEvent,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../tui.ts";

export type MouseRegionHandler = (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

/** Adds mouse handling to an existing component without changing its rendering. */
export class MouseRegion implements Component {
	private renderedChildren: RenderedChild[] = [];

	getRenderedChildren(): readonly RenderedChild[] {
		return this.renderedChildren;
	}

	private readonly child: Component;
	private readonly onMouse: MouseRegionHandler;

	constructor(child: Component, onMouse: MouseRegionHandler) {
		this.child = child;
		this.onMouse = onMouse;
	}

	render(width: number): string[] {
		const lines = this.child.render(width);
		this.renderedChildren = [{ component: this.child, bounds: { x: 0, y: 0, width, height: lines.length } }];
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
		const childResult = dispatchMouseEvent(this.child, event);
		return childResult ?? this.onMouse(event);
	}

	invalidate(): void {
		this.child.invalidate();
	}
}
