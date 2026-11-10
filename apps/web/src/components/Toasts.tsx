import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { dismissToast, useStore } from "../lib/store.ts";

const M = defineMessages({
	zh: {
		dismiss: "点击关闭",
	},
	en: {
		dismiss: "Click to dismiss",
	},
});

export function Toasts() {
	const tr = useT(M);
	const toasts = useStore((s) => s.toasts);
	return (
		<div className="pointer-events-none fixed right-3 bottom-3 left-3 z-50 flex flex-col gap-2 md:right-5 md:bottom-5 md:left-auto md:w-80" aria-live="polite">
			{toasts.map((toast) => (
				<button
					type="button"
					key={toast.id}
					onClick={() => dismissToast(toast.id)}
					title={tr("dismiss")}
					className={clsx(
						"sheen pointer-events-auto flex w-full animate-pop cursor-pointer items-start gap-2.5 rounded-xl border bg-ink-900/95 px-3.5 py-3 text-left text-sm shadow-2xl shadow-black/40 backdrop-blur transition-opacity hover:opacity-80",
						toast.level === "error" ? "border-rose-400/30" : toast.level === "warning" ? "border-ember-300/30" : "border-ink-700",
					)}
				>
					{toast.level === "error" ? (
						<AlertTriangle className="icon-shake mt-0.5 size-4 shrink-0 text-rose-400" />
					) : toast.level === "warning" ? (
						<Info className="mt-0.5 size-4 shrink-0 text-ember-300" />
					) : (
						<span className="toast-spark relative mt-0.5 shrink-0 text-moss-400">
							<CheckCircle2 className="icon-pop size-4" />
						</span>
					)}
					<span className="break-words text-ink-200">{toast.message}</span>
				</button>
			))}
		</div>
	);
}
