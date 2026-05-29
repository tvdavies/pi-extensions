/**
 * Scheduler Extension
 *
 * Schedule a prompt to be delivered to the agent later, from within the
 * current session. When a scheduled job fires, its prompt is injected as a
 * user message (as if you had typed it), triggering the agent to act on it.
 *
 * Commands:
 *   /schedule 10m Check PR #4988 and run /address-pr-feedback, applying the plan
 *   /schedule 30s ping me
 *   /schedule 2025-12-31T17:00 wrap up for the year
 *   /schedule list            - list pending jobs
 *   /schedule cancel <id>     - cancel a pending job
 *   /schedule cancel all      - cancel everything
 *
 * Duration syntax: combine s/m/h/d, e.g. "90s", "10m", "1h30m", "2d".
 * Absolute time: any string Date can parse (ISO 8601 recommended).
 *
 * Notes:
 * - Jobs live only while this pi process runs. They are persisted to the
 *   session so they survive /reload, but a full quit clears pending timers
 *   (they are reloaded but fired immediately if already overdue).
 * - When the agent is busy, the prompt is queued as a follow-up so it runs
 *   once the current work finishes rather than interrupting it.
 */

import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

type ScheduledJob = {
	id: string;
	/** Epoch ms when the job should fire. */
	dueAt: number;
	/** The prompt text to deliver to the agent. */
	prompt: string;
	/** Original human-readable schedule spec, for display. */
	spec: string;
};

const STATE_TYPE = "scheduler-job";
const CANCEL_TYPE = "scheduler-cancel";

const schedulePromptSchema = Type.Object({
	when: Type.String({
		description:
			'When to run the prompt. Use a duration like "10m", "1h30m", or "2d", or an absolute date/time such as "2026-05-29T17:00:00".',
	}),
	prompt: Type.String({
		description: "The prompt to deliver back to the agent when the schedule fires.",
	}),
});

type SchedulePromptInput = Static<typeof schedulePromptSchema>;

const cancelScheduledPromptSchema = Type.Object({
	id: Type.String({
		description:
			'The full id or displayed short id of the scheduled prompt to cancel, or "all" to cancel every pending scheduled prompt.',
	}),
});

type CancelScheduledPromptInput = Static<typeof cancelScheduledPromptSchema>;

export default function (pi: ExtensionAPI) {
	// In-memory timers, keyed by job id. Not persisted (timers can't be).
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	// Source of truth for pending jobs in this runtime.
	const jobs = new Map<string, ScheduledJob>();
	// Latest context seen, so timer callbacks (which have no ctx of their own)
	// can check idle state and update UI. Refreshed on every event/command.
	let lastCtx: ExtensionContext | undefined;

	const shortId = (id: string) => id.slice(0, 8);

	function describeDelay(ms: number): string {
		if (ms <= 0) return "now";
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		const rem = s % 60;
		if (m < 60) return rem ? `${m}m${rem}s` : `${m}m`;
		const h = Math.floor(m / 60);
		const remM = m % 60;
		if (h < 24) return remM ? `${h}h${remM}m` : `${h}h`;
		const d = Math.floor(h / 24);
		const remH = h % 24;
		return remH ? `${d}d${remH}h` : `${d}d`;
	}

	function updateWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (jobs.size === 0) {
			ctx.ui.setWidget("scheduler", []);
			return;
		}
		const now = Date.now();
		const lines = [...jobs.values()]
			.sort((a, b) => a.dueAt - b.dueAt)
			.map((job) => {
				const when = describeDelay(job.dueAt - now);
				const preview =
					job.prompt.length > 40
						? `${job.prompt.slice(0, 40)}…`
						: job.prompt;
				return `⏰ ${shortId(job.id)} in ${when}: ${preview}`;
			});
		ctx.ui.setWidget("scheduler", [`Scheduled (${jobs.size}):`, ...lines]);
	}

	/**
	 * Parse a duration like "90s", "10m", "1h30m", "2d" into milliseconds.
	 * Returns null if the string is not a pure duration.
	 */
	function parseDuration(input: string): number | null {
		const trimmed = input.trim().toLowerCase();
		if (!/^(\d+\s*[smhd]\s*)+$/.test(trimmed)) return null;
		const unitMs: Record<string, number> = {
			s: 1000,
			m: 60_000,
			h: 3_600_000,
			d: 86_400_000,
		};
		let total = 0;
		for (const match of trimmed.matchAll(/(\d+)\s*([smhd])/g)) {
			total += Number(match[1]) * unitMs[match[2]];
		}
		return total > 0 ? total : null;
	}

	function parseWhenSpec(when: string): { dueAt: number; spec: string } | null {
		const trimmed = when.trim();
		if (!trimmed) return null;

		const durationMs = parseDuration(trimmed);
		if (durationMs !== null) {
			return {
				dueAt: Date.now() + durationMs,
				spec: `in ${describeDelay(durationMs)}`,
			};
		}

		const parsed = Date.parse(trimmed);
		if (!Number.isNaN(parsed)) {
			return {
				dueAt: parsed,
				spec: `at ${new Date(parsed).toLocaleString()}`,
			};
		}

		return null;
	}

	/**
	 * Resolve the first token of args into an absolute due time (epoch ms),
	 * returning the remaining text as the prompt. Supports either a duration
	 * token or an ISO/parseable date token.
	 */
	function parseWhen(
		args: string,
	): { dueAt: number; spec: string; prompt: string } | null {
		const trimmed = args.trim();
		if (!trimmed) return null;

		// Split into the first whitespace-delimited token and the rest.
		const firstSpace = trimmed.search(/\s/);
		const firstToken =
			firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
		const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

		const parsed = parseWhenSpec(firstToken);
		return parsed ? { ...parsed, prompt: rest } : null;
	}

	function fireJob(job: ScheduledJob) {
		// Clean up bookkeeping before delivering.
		timers.delete(job.id);
		jobs.delete(job.id);
		if (lastCtx) updateWidget(lastCtx);

		const header = `[scheduled ${shortId(job.id)}]`;
		const message = `${header} ${job.prompt}`;

		// If the agent is mid-turn, queue as a follow-up so we don't clobber
		// in-flight work; otherwise deliver immediately and trigger a turn.
		// isIdle() lives on the context, not on pi, so consult the last ctx we
		// saw. When unknown, assume busy and queue as follow-up — that is the
		// safe choice, since sendUserMessage() throws if it delivers mid-stream
		// without a deliverAs.
		const idle = lastCtx?.isIdle() ?? false;
		if (idle) {
			pi.sendUserMessage(message);
		} else {
			pi.sendUserMessage(message, { deliverAs: "followUp" });
		}
	}

	function scheduleTimer(job: ScheduledJob) {
		const delay = Math.max(0, job.dueAt - Date.now());
		// setTimeout caps out around 24.8 days; clamp and re-arm if needed.
		const MAX_DELAY = 2_147_483_647;
		if (delay > MAX_DELAY) {
			const timer = setTimeout(() => scheduleTimer(job), MAX_DELAY);
			timers.set(job.id, timer);
			return;
		}
		const timer = setTimeout(() => fireJob(job), delay);
		timers.set(job.id, timer);
	}

	function addJob(job: ScheduledJob, ctx: ExtensionContext) {
		jobs.set(job.id, job);
		scheduleTimer(job);
		// Persist so the job survives /reload.
		pi.appendEntry(STATE_TYPE, job);
		updateWidget(ctx);
	}

	function cancelJob(id: string): boolean {
		const timer = timers.get(id);
		if (timer) clearTimeout(timer);
		timers.delete(id);
		const existed = jobs.delete(id);
		if (existed) pi.appendEntry(CANCEL_TYPE, { id });
		return existed;
	}

	function findJobId(target: string): string | undefined {
		return [...jobs.keys()].find(
			(id) => id === target || shortId(id) === target,
		);
	}

	function listJobLines(): string[] {
		const now = Date.now();
		return [...jobs.values()]
			.sort((a, b) => a.dueAt - b.dueAt)
			.map(
				(job) =>
					`${shortId(job.id)}  (${job.spec}, in ${describeDelay(
						job.dueAt - now,
					)})  ${job.prompt}`,
			);
	}

	function scheduledText(job: ScheduledJob): string {
		return `Scheduled ${shortId(job.id)} ${job.spec} (in ${describeDelay(
			job.dueAt - Date.now(),
		)}).`;
	}

	// Restore persisted jobs on startup/reload. We replay the append-only log
	// of job/cancel entries to reconstruct the set of still-pending jobs.
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		const restored = new Map<string, ScheduledJob>();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === STATE_TYPE) {
				const data = entry.data as ScheduledJob | undefined;
				if (data?.id) restored.set(data.id, data);
			} else if (entry.customType === CANCEL_TYPE) {
				const data = entry.data as { id?: string } | undefined;
				if (data?.id) restored.delete(data.id);
			}
		}

		const now = Date.now();
		let overdue = 0;
		for (const job of restored.values()) {
			jobs.set(job.id, job);
			if (job.dueAt <= now) {
				// Already past due (e.g. process was down). Fire shortly so the
				// session_start handler can finish first.
				overdue += 1;
				const j = job;
				setTimeout(() => fireJob(j), 50);
			} else {
				scheduleTimer(job);
			}
		}

		updateWidget(ctx);
		if (ctx.hasUI && (jobs.size > 0 || overdue > 0)) {
			ctx.ui.notify(
				`Scheduler: ${jobs.size} pending${overdue ? `, ${overdue} firing now` : ""}`,
				"info",
			);
		}
	});

	// Keep a fresh context around for timer callbacks. turn_end fires often
	// enough to reflect idle/busy transitions without being noisy.
	pi.on("turn_end", async (_event, ctx) => {
		lastCtx = ctx;
	});
	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
	});

	// Clear timers on shutdown; jobs themselves are persisted and reloaded.
	pi.on("session_shutdown", async () => {
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	});

	pi.registerTool({
		name: "schedule_prompt",
		label: "schedule prompt",
		description:
			"Schedule a prompt to be delivered back to the agent later in this pi session. Use when the user asks for a reminder, delayed follow-up, timed check, or wants you to continue work later.",
		promptSnippet: "Schedule a prompt to run later in this session",
		promptGuidelines: [
			"Use schedule_prompt when a user asks you to do something later, check back after a delay, or remind/continue at a specific time.",
			"Do not use schedule_prompt for tasks that should happen immediately.",
		],
		parameters: schedulePromptSchema,
		async execute(_toolCallId, params: SchedulePromptInput, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const parsed = parseWhenSpec(params.when);
			if (!parsed) {
				return {
					content: [
						{
							type: "text",
							text: 'Could not parse time. Use a duration like "10m" or "1h30m", or an absolute time like "2026-05-29T17:00:00".',
						},
					],
					details: { ok: false },
				};
			}

			const prompt = params.prompt.trim();
			if (!prompt) {
				return {
					content: [{ type: "text", text: "Provide a prompt to schedule." }],
					details: { ok: false },
				};
			}

			const job: ScheduledJob = {
				id: randomUUID(),
				dueAt: parsed.dueAt,
				prompt,
				spec: parsed.spec,
			};
			addJob(job, ctx);

			return {
				content: [{ type: "text", text: scheduledText(job) }],
				details: { ok: true, job },
			};
		},
	});

	pi.registerTool({
		name: "list_scheduled_prompts",
		label: "list scheduled prompts",
		description: "List pending prompts scheduled in this pi session.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const text =
				jobs.size === 0 ? "No scheduled prompts." : listJobLines().join("\n");
			return {
				content: [{ type: "text", text }],
				details: { count: jobs.size },
			};
		},
	});

	pi.registerTool({
		name: "cancel_scheduled_prompt",
		label: "cancel scheduled prompt",
		description:
			'Cancel a pending scheduled prompt by full id, displayed short id, or use "all" to cancel every pending scheduled prompt.',
		parameters: cancelScheduledPromptSchema,
		async execute(
			_toolCallId,
			params: CancelScheduledPromptInput,
			_signal,
			_onUpdate,
			ctx,
		) {
			lastCtx = ctx;
			const target = params.id.trim();
			if (!target) {
				return {
					content: [{ type: "text", text: "Provide a scheduled prompt id." }],
					details: { ok: false },
				};
			}

			if (target === "all") {
				const count = jobs.size;
				for (const id of [...jobs.keys()]) cancelJob(id);
				updateWidget(ctx);
				return {
					content: [{ type: "text", text: `Cancelled ${count} job(s).` }],
					details: { ok: true, count },
				};
			}

			const match = findJobId(target);
			if (!match) {
				return {
					content: [
						{ type: "text", text: `No scheduled prompt matching "${target}".` },
					],
					details: { ok: false },
				};
			}

			cancelJob(match);
			updateWidget(ctx);
			return {
				content: [{ type: "text", text: `Cancelled ${shortId(match)}.` }],
				details: { ok: true, id: match },
			};
		},
	});

	pi.registerCommand("schedule", {
		description:
			"Schedule a prompt for later: /schedule <10m|ISO-time> <prompt>, or /schedule list|cancel <id|all>",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "list", label: "list — show pending jobs" },
				{ value: "cancel ", label: "cancel — cancel a job by id or 'all'" },
				{ value: "5m ", label: "5m — in five minutes" },
				{ value: "10m ", label: "10m — in ten minutes" },
				{ value: "1h ", label: "1h — in one hour" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const trimmed = args.trim();

			if (!trimmed) {
				ctx.ui.notify(
					"Usage: /schedule <10m|ISO-time> <prompt> | list | cancel <id|all>",
					"warning",
				);
				return;
			}

			// Subcommand: list
			if (trimmed === "list") {
				if (jobs.size === 0) {
					ctx.ui.notify("No scheduled jobs.", "info");
					return;
				}
				ctx.ui.notify(`Scheduled jobs:\n${listJobLines().join("\n")}`, "info");
				return;
			}

			// Subcommand: cancel
			if (trimmed === "cancel" || trimmed.startsWith("cancel ")) {
				const target = trimmed.slice("cancel".length).trim();
				if (!target) {
					ctx.ui.notify("Usage: /schedule cancel <id|all>", "warning");
					return;
				}
				if (target === "all") {
					const count = jobs.size;
					for (const id of [...jobs.keys()]) cancelJob(id);
					updateWidget(ctx);
					ctx.ui.notify(`Cancelled ${count} job(s).`, "info");
					return;
				}
				// Match by full id or short-id prefix.
				const match = findJobId(target);
				if (!match) {
					ctx.ui.notify(`No job matching "${target}".`, "warning");
					return;
				}
				cancelJob(match);
				updateWidget(ctx);
				ctx.ui.notify(`Cancelled ${shortId(match)}.`, "info");
				return;
			}

			// Otherwise: schedule a new job.
			const parsed = parseWhen(trimmed);
			if (!parsed) {
				ctx.ui.notify(
					'Could not parse time. Use a duration like "10m" or "1h30m", or an ISO time like "2025-12-31T17:00".',
					"warning",
				);
				return;
			}
			if (!parsed.prompt) {
				ctx.ui.notify("Provide a prompt after the time.", "warning");
				return;
			}

			const job: ScheduledJob = {
				id: randomUUID(),
				dueAt: parsed.dueAt,
				prompt: parsed.prompt,
				spec: parsed.spec,
			};
			addJob(job, ctx);

			ctx.ui.notify(scheduledText(job), "info");
		},
	});
}
