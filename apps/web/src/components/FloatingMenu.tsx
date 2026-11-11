import clsx from "clsx";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Gap kept from the screen edges, and between the anchor and the panel. */
const MARGIN = 8;
const GAP = 6;
/** Floor for the panel height when both sides are cramped (a short window, a phone keyboard): it scrolls instead. */
const MIN_HEIGHT = 96;

export interface FloatingMenuProps {
	/** The trigger; the panel hangs off its box. */
	anchor: RefObject<HTMLElement | null>;
	onClose: () => void;
	/** Preferred width in px, clamped to the visible area. */
	width: number;
	align?: "start" | "end";
	/** Surface extras (padding, radius, opacity) on top of the shared chrome. */
	className?: string;
	children: ReactNode;
}

interface Placement {
	top: number;
	left: number;
	width: number;
	maxHeight: number;
}

/**
 * Dropdown drawn in a portal at fixed coordinates, for any menu that hangs off a trigger inside a composer.
 *
 * Absolutely positioned menus cannot work there: the inline composer clips and scrolls, the phone layout has no
 * `relative` ancestor to anchor to (so `bottom-full` resolved against the whole column), and the full-screen sheet is a
 * portal whose dialog is `relative` *and* `overflow-hidden` — the menu landed above the dialog and was cut away
 * entirely, which is why the mode picker stopped answering taps once the sheet was open.
 *
 * So the panel is rendered into `<body>`, measured against the trigger, flipped to whichever side has more room and
 * clamped into the *visual* viewport (the part above the phone keyboard). It also carries `data-floating-menu`, which
 * is what `usePopover` looks for so a click inside the menu does not count as a click outside it.
 */
export function FloatingMenu({ anchor, onClose, width, align = "start", className, children }: FloatingMenuProps) {
	const panel = useRef<HTMLDivElement>(null);
	const [place, setPlace] = useState<Placement | null>(null);

	const measure = useCallback(() => {
		const el = panel.current;
		const a = anchor.current?.getBoundingClientRect();
		if (!el || !a) return;
		const vv = window.visualViewport;
		const vLeft = vv?.offsetLeft ?? 0;
		const vTop = vv?.offsetTop ?? 0;
		const vWidth = vv?.width ?? window.innerWidth;
		const vBottom = (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight);

		const w = Math.min(width, vWidth - MARGIN * 2);
		// Scrolled clean out of sight (a sidebar list, a long chat): there is nothing left to hang off.
		if (a.bottom < vTop || a.top > vBottom) {
			onClose();
			return;
		}
		const above = a.top - vTop - GAP - MARGIN;
		const below = vBottom - a.bottom - GAP - MARGIN;
		const up = above >= below;
		// Cap the height *before* measuring, so the panel never grows past the room the chosen side has.
		const maxHeight = Math.max(MIN_HEIGHT, Math.round(up ? above : below));
		el.style.maxHeight = `${maxHeight}px`;
		el.style.width = `${w}px`;

		const h = el.offsetHeight;
		const top = Math.max(vTop + MARGIN, Math.min(up ? a.top - GAP - h : a.bottom + GAP, vBottom - h - MARGIN));
		const left = Math.max(vLeft + MARGIN, Math.min(align === "end" ? a.right - w : a.left, vLeft + vWidth - w - MARGIN));
		const next: Placement = { top: Math.round(top), left: Math.round(left), width: Math.round(w), maxHeight };
		setPlace((prev) => (prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.maxHeight === next.maxHeight ? prev : next));
	}, [anchor, width, align, onClose]);

	useLayoutEffect(() => {
		measure();
	}, [measure]);

	// The trigger moves when the keyboard opens, the phone rotates or the sheet is resized — follow it instead of closing.
	useEffect(() => {
		let frame = 0;
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				measure();
			});
		};
		const vv = window.visualViewport;
		window.addEventListener("resize", schedule);
		vv?.addEventListener("resize", schedule);
		vv?.addEventListener("scroll", schedule);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("resize", schedule);
			vv?.removeEventListener("resize", schedule);
			vv?.removeEventListener("scroll", schedule);
		};
	}, [measure]);

	// Content-driven height changes (a filter narrowing the list, a section collapsing) move the panel too.
	useEffect(() => {
		const el = panel.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => measure());
		ro.observe(el);
		return () => ro.disconnect();
	}, [measure]);

	// Escape is not handled here: every caller opens the menu through `usePopover`, which already closes it on Esc.
	// Doing it twice would also collapse the full-screen sheet the menu was opened from.

	return createPortal(
		<div
			ref={panel}
			data-floating-menu
			style={{
				position: "fixed",
				top: place?.top ?? 0,
				left: place?.left ?? 0,
				width: place?.width ?? Math.min(width, window.innerWidth - MARGIN * 2),
				maxHeight: place?.maxHeight,
				visibility: place ? "visible" : "hidden",
			}}
			className={clsx("z-[200] animate-rise overflow-y-auto overflow-x-hidden overscroll-contain border bg-ink-900/97 text-left shadow-2xl shadow-black/40 backdrop-blur", className)}
			// The panel is portalled, but React still bubbles through the tree it came from: a row with its own click
			// handler must not fire when a menu item is picked.
			onClick={(e) => e.stopPropagation()}
		>
			{children}
		</div>,
		document.body,
	);
}
