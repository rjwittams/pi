import type { SurfaceRect } from "./surface.ts";
import { getKittyImageMetadata } from "./terminal-image.ts";

/** Crop registered inline Kitty images around opaque overlays. Coordinates share
 * the renderer's row space; cursor moves return to each image's original anchor.
 * Upload bytes are retained, so the normal image cache can reuse them.
 */
export function occludeImageRow(line: string, row: number, covers: readonly SurfaceRect[]): string {
	if (!line || covers.length === 0) return line;
	let col = 0;
	return line.replace(
		/\x1b\[(\d+)G|\r|\x1b_G[^;\x1b]*;[^\x1b]*\x1b\\(?:\x1b_Gm=[01];[^\x1b]*\x1b\\)*/g,
		(sequence: string, column: string | undefined) => {
			if (column !== undefined) {
				col = Number(column) - 1;
				return sequence;
			}
			if (sequence === "\r") {
				col = 0;
				return sequence;
			}
			const header = /^\x1b_G([^;]*);/.exec(sequence);
			const metadata = getKittyImageMetadata(sequence);
			if (!header || !metadata) return sequence;
			const params = new Map(
				header[1].split(",").map((param) => {
					const [key, value] = param.split("=");
					return [key, value];
				}),
			);
			// renderImage's no-cursor-movement placements are the renderer-owned path.
			// Leave arbitrary external commands and other protocols untouched.
			if (params.get("a") !== "T" || params.get("C") !== "1") return sequence;
			const bounds = {
				x: col,
				y: row,
				width: Number(params.get("c") ?? metadata.columns),
				height: Number(params.get("r") ?? metadata.rows),
			};
			let pieces = [bounds];
			for (const cover of covers) {
				pieces = pieces.flatMap((rect) => {
					const x = Math.max(rect.x, cover.x),
						y = Math.max(rect.y, cover.y);
					const right = Math.min(rect.x + rect.width, cover.x + cover.width);
					const bottom = Math.min(rect.y + rect.height, cover.y + cover.height);
					if (right <= x || bottom <= y) return [rect];
					return [
						{ ...rect, height: y - rect.y },
						{ ...rect, y: bottom, height: rect.y + rect.height - bottom },
						{ x: rect.x, y, width: x - rect.x, height: bottom - y },
						{ x: right, y, width: rect.x + rect.width - right, height: bottom - y },
					].filter((piece) => piece.width > 0 && piece.height > 0);
				});
			}
			if (pieces.length === 1 && pieces[0] === bounds) return sequence;
			const sourceX = Number(params.get("x") ?? 0),
				sourceY = Number(params.get("y") ?? 0);
			const sourceWidth = Number(params.get("w") ?? metadata.widthPx),
				sourceHeight = Number(params.get("h") ?? metadata.heightPx);
			// Keep the original cell dimensions in the upload header: the regular
			// renderer uses them to reserve rows before emitting a multi-row image.
			let result = sequence.replace(/(?<=\x1b_G)a=T(?=,|;)/, "a=t");
			for (const [index, piece] of pieces.entries()) {
				const x = sourceX + Math.floor(((piece.x - bounds.x) * sourceWidth) / bounds.width);
				const y = sourceY + Math.floor(((piece.y - bounds.y) * sourceHeight) / bounds.height);
				const right = sourceX + Math.floor(((piece.x + piece.width - bounds.x) * sourceWidth) / bounds.width);
				const bottom = sourceY + Math.floor(((piece.y + piece.height - bounds.y) * sourceHeight) / bounds.height);
				if (right <= x || bottom <= y) continue;
				const down = piece.y - row;
				if (down) result += `\x1b[${down}B`;
				result += `\x1b[${piece.x + 1}G\x1b_Ga=p,q=2,C=1,i=${metadata.imageId},p=${index + 1},x=${x},y=${y},w=${right - x},h=${bottom - y},c=${piece.width},r=${piece.height},z=${params.get("z") ?? 0}\x1b\\`;
				if (down) result += `\x1b[${down}A`;
				result += `\x1b[${col + 1}G`;
			}
			return result;
		},
	);
}
