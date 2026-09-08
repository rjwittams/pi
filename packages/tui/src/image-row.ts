import { getKittyImagePlacement, isImageLine, type KittyImagePlacement } from "./terminal-image.ts";
import { visibleWidth } from "./utils.ts";

/** Image output is kept out of the text grid used for composition and cursors. */
export interface ImageRow {
	text: string;
	images: string;
}

/** Visit each upload, keeping its continuation chunks together and leaving placements untouched. */
export function mapKittyImageTransmissions(
	line: string,
	map: (transmission: string, placement: KittyImagePlacement) => string,
): string {
	return line.replace(/\x1b_G[^;\x1b]*;[^\x1b]*\x1b\\(?:\x1b_Gm=[01];[^\x1b]*\x1b\\)*/g, (transmission) => {
		if (!/\x1b_G(?:[^;]*,)?a=[Tt](?:,|;)/.test(transmission)) return transmission;
		const placement = getKittyImagePlacement(transmission);
		return placement ? map(transmission, placement) : transmission;
	});
}

export function splitImageRow(line: string, columnOffset = 0): ImageRow {
	if (!isImageLine(line)) return { text: line, images: "" };
	let text = "";
	let images = "";
	let end = 0;
	// Keep iTerm's cursor-up prefix with the image: its inline placement moves
	// back down to this row. Kitty chunks are preserved byte-for-byte.
	const commands = /(?:\x1b_G[^\x1b]*\x1b\\)+|(?:\x1b\[\d+A)?\x1b\]1337;File=[^\x07\x1b]*(?:\x07|\x1b\\)/g;
	for (const match of line.matchAll(commands)) {
		text += line.slice(end, match.index);
		const col = columnOffset + visibleWidth(text);
		if (col > 0) images += `\x1b[${col + 1}G`;
		images += match[0];
		end = match.index + match[0].length;
	}
	text += line.slice(end);
	return { text, images };
}

/** Called only when emitting a row, after text composition and cursor extraction. */
export function emitImageRow(text: string, images: string): string {
	if (!images) return text;
	return (visibleWidth(text) > 0 ? `${text}\r` : "") + images;
}
