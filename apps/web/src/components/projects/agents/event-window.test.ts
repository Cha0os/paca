import { describe, expect, it } from "vitest";
import type { AgentConversationEvent } from "@/lib/agent-api";
import {
	type EventWindow,
	emptyEventWindow,
	eventWindowReducer,
	hasOlder,
} from "./event-window";

function ev(index: number): AgentConversationEvent {
	return {
		id: `event-${index}`,
		conversation_id: "conv-1",
		event_index: index,
		event_type: "ACPToolCallEvent",
		event_source: "agent",
		payload: {},
		created_at: "2026-01-01T00:00:00Z",
	};
}

const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));

/** A window holding 400..599 of a 600-event conversation. */
function tailWindow(): EventWindow {
	return eventWindowReducer(emptyEventWindow, {
		type: "loaded",
		items: range(400, 599),
		total: 600,
	});
}

const indices = (w: EventWindow) => w.events.map((e) => e.event_index);

describe("eventWindowReducer", () => {
	describe("loaded", () => {
		it("anchors the window on the events it was given", () => {
			const w = tailWindow();
			expect(w.lo).toBe(400);
			expect(w.hi).toBe(599);
			expect(w.events).toHaveLength(200);
			expect(w.total).toBe(600);
		});

		it("sorts by event_index so the transformer always sees a run in order", () => {
			const w = eventWindowReducer(emptyEventWindow, {
				type: "loaded",
				items: [ev(2), ev(0), ev(1)],
				total: 3,
			});
			expect(indices(w)).toEqual([0, 1, 2]);
		});

		it("trusts the loaded events over a total that undercounts them", () => {
			const w = eventWindowReducer(emptyEventWindow, {
				type: "loaded",
				items: range(0, 9),
				total: 4,
			});
			expect(w.total).toBe(10);
		});

		it("handles a conversation with no events", () => {
			const w = eventWindowReducer(emptyEventWindow, {
				type: "loaded",
				items: [],
				total: 0,
			});
			expect(w).toEqual(emptyEventWindow);
			expect(hasOlder(w)).toBe(false);
		});
	});

	describe("prepended", () => {
		it("extends the window downwards", () => {
			const w = eventWindowReducer(tailWindow(), {
				type: "prepended",
				items: range(200, 399),
				total: 600,
			});
			expect(w.lo).toBe(200);
			expect(w.hi).toBe(599);
			expect(w.events).toHaveLength(400);
			expect(indices(w)[0]).toBe(200);
		});

		it("refuses a page that would leave a hole", () => {
			const before = tailWindow();
			// 200..398 stops one short of the window's lo (400).
			const after = eventWindowReducer(before, {
				type: "prepended",
				items: range(200, 398),
				total: 600,
			});
			expect(after).toBe(before);
		});

		it("ignores events already inside the window", () => {
			const before = tailWindow();
			const after = eventWindowReducer(before, {
				type: "prepended",
				items: range(400, 450),
				total: 600,
			});
			expect(after.events).toHaveLength(200);
			expect(after.lo).toBe(400);
		});
	});

	describe("appended", () => {
		it("extends the window upwards and clears the pending count", () => {
			const w = eventWindowReducer(tailWindow(), {
				type: "appended",
				items: range(600, 604),
				total: 605,
			});
			expect(w.hi).toBe(604);
			expect(w.total).toBe(605);
			expect(w.newBelow).toBe(0);
			expect(w.events).toHaveLength(205);
		});

		it("refuses a page that would leave a hole", () => {
			const before = tailWindow();
			const after = eventWindowReducer(before, {
				type: "appended",
				items: range(700, 705),
				total: 706,
			});
			expect(after).toBe(before);
		});

		it("accepts any starting index into an empty window", () => {
			const w = eventWindowReducer(emptyEventWindow, {
				type: "appended",
				items: range(50, 59),
				total: 60,
			});
			expect(w.lo).toBe(50);
			expect(w.hi).toBe(59);
		});

		it("still reports what is waiting when not following", () => {
			const away = eventWindowReducer(tailWindow(), {
				type: "following",
				following: false,
			});
			const w = eventWindowReducer(away, {
				type: "appended",
				items: range(600, 601),
				total: 610,
			});
			// Loaded through 601, server says 610 exist.
			expect(w.newBelow).toBe(8);
		});

		it("records a total that grew even when the page adds nothing", () => {
			const w = eventWindowReducer(tailWindow(), {
				type: "appended",
				items: [],
				total: 640,
			});
			expect(w.total).toBe(640);
			expect(w.hi).toBe(599);
		});
	});

	describe("noticed", () => {
		it("counts events past the window from the reported index", () => {
			const w = eventWindowReducer(tailWindow(), {
				type: "noticed",
				index: 604,
			});
			expect(w.total).toBe(605);
			expect(w.newBelow).toBe(5);
		});

		it("assumes one more event when the API reports no index", () => {
			const w = eventWindowReducer(tailWindow(), {
				type: "noticed",
				index: null,
			});
			expect(w.total).toBe(601);
			expect(w.newBelow).toBe(1);
		});

		it("never counts backwards from a stale index", () => {
			const w = eventWindowReducer(tailWindow(), {
				type: "noticed",
				index: 10,
			});
			expect(w.total).toBe(600);
			expect(w.newBelow).toBe(0);
		});
	});

	describe("following", () => {
		it("clears the pending count when resuming", () => {
			const behind = eventWindowReducer(
				eventWindowReducer(tailWindow(), {
					type: "following",
					following: false,
				}),
				{ type: "noticed", index: 620 },
			);
			expect(behind.newBelow).toBe(21);

			const resumed = eventWindowReducer(behind, {
				type: "following",
				following: true,
			});
			expect(resumed.newBelow).toBe(0);
			expect(resumed.following).toBe(true);
		});
	});

	it("reset drops everything, including the follow state", () => {
		const dirty = eventWindowReducer(tailWindow(), {
			type: "following",
			following: false,
		});
		expect(eventWindowReducer(dirty, { type: "reset" })).toEqual(
			emptyEventWindow,
		);
	});

	describe("invariants", () => {
		it("keeps the window contiguous and ascending through every action", () => {
			let w = tailWindow();
			w = eventWindowReducer(w, {
				type: "prepended",
				items: range(200, 399),
				total: 600,
			});
			w = eventWindowReducer(w, {
				type: "appended",
				items: range(600, 610),
				total: 611,
			});
			w = eventWindowReducer(w, { type: "noticed", index: 620 });

			const idx = indices(w);
			expect(idx[0]).toBe(w.lo);
			expect(idx[idx.length - 1]).toBe(w.hi);
			expect(idx).toEqual(
				Array.from({ length: w.hi - w.lo + 1 }, (_, i) => w.lo + i),
			);
		});
	});

	describe("selectors", () => {
		it("hasOlder is false for an empty window and true below the start", () => {
			expect(hasOlder(emptyEventWindow)).toBe(false);
			expect(hasOlder(tailWindow())).toBe(true);
			const whole = eventWindowReducer(emptyEventWindow, {
				type: "loaded",
				items: range(0, 5),
				total: 6,
			});
			expect(hasOlder(whole)).toBe(false);
		});
	});
	describe("a conversation that was empty when opened", () => {
		it("accepts the events that arrive afterwards", () => {
			const empty = eventWindowReducer(emptyEventWindow, {
				type: "loaded",
				items: [],
				total: 0,
			});
			expect(empty.hi).toBe(-1);

			// Realtime reports the first event, then it is fetched.
			const noticed = eventWindowReducer(empty, { type: "noticed", index: 0 });
			expect(noticed.total).toBe(1);
			// hi + 1 < total is what tells the hook to fetch from offset 0.
			expect(noticed.hi + 1).toBeLessThan(noticed.total);

			const w = eventWindowReducer(noticed, {
				type: "appended",
				items: range(0, 0),
				total: 1,
			});
			expect(w.lo).toBe(0);
			expect(w.hi).toBe(0);
			expect(w.events).toHaveLength(1);
			expect(w.hi + 1).toBe(w.total);
		});
	});
});
