import type { AgentConversationEvent } from "@/lib/agent-api";

/**
 * A contiguous slice of a conversation's event stream.
 *
 * `event_index` is gapless, so an index is also an offset and a page addresses
 * the same events however many arrive later.
 *
 * The slice must stay contiguous: `eventsToThreadMessages` carries state across
 * the array it is given (open tool calls keyed by id, the assistant message
 * being accumulated), so it is only correct over an unbroken run.
 */
export type EventWindow = {
	/** Lowest loaded `event_index`. 0 once the whole stream is loaded. */
	lo: number;
	/** Highest loaded `event_index`, inclusive. -1 while nothing is loaded. */
	hi: number;
	/** The loaded events: contiguous `[lo..hi]`, ascending. */
	events: AgentConversationEvent[];
	/** Highest event count the server has reported. */
	total: number;
	/** While true, new events are fetched as they land; while false, only counted. */
	following: boolean;
	/** Events known to exist past `hi`, while not following. */
	newBelow: number;
};

export const emptyEventWindow: EventWindow = {
	lo: 0,
	hi: -1,
	events: [],
	total: 0,
	following: true,
	newBelow: 0,
};

export type EventWindowAction =
	| { type: "reset" }
	| { type: "loaded"; items: AgentConversationEvent[]; total: number }
	| { type: "prepended"; items: AgentConversationEvent[]; total: number }
	| { type: "appended"; items: AgentConversationEvent[]; total: number }
	/**
	 * Realtime reported an event. A null `index` (API does not send one) assumes
	 * one more event; the next response's `total` corrects it.
	 */
	| { type: "noticed"; index: number | null }
	| { type: "following"; following: boolean };

const byIndex = (items: AgentConversationEvent[]) =>
	[...items].sort((a, b) => a.event_index - b.event_index);

const countNewBelow = (total: number, hi: number) =>
	Math.max(0, total - 1 - hi);

export function eventWindowReducer(
	state: EventWindow,
	action: EventWindowAction,
): EventWindow {
	switch (action.type) {
		case "reset":
			return emptyEventWindow;

		case "loaded": {
			const items = byIndex(action.items);
			if (items.length === 0) {
				return { ...emptyEventWindow, total: action.total };
			}
			const hi = items[items.length - 1].event_index;
			return {
				lo: items[0].event_index,
				hi,
				events: items,
				total: Math.max(action.total, hi + 1),
				following: state.following,
				newBelow: 0,
			};
		}

		case "prepended": {
			const items = byIndex(action.items).filter(
				(e) => e.event_index < state.lo,
			);
			const total = Math.max(state.total, action.total);
			if (items.length === 0) return { ...state, total };
			// Reject a page that would leave a hole; the caller re-requests it.
			if (items[items.length - 1].event_index !== state.lo - 1) return state;
			return {
				...state,
				lo: items[0].event_index,
				events: [...items, ...state.events],
				total,
			};
		}

		case "appended": {
			const items = byIndex(action.items).filter(
				(e) => e.event_index > state.hi,
			);
			if (items.length === 0) {
				return { ...state, total: Math.max(state.total, action.total) };
			}
			// An empty window accepts any starting index; a loaded one only the next.
			if (state.hi >= 0 && items[0].event_index !== state.hi + 1) return state;
			const hi = items[items.length - 1].event_index;
			const total = Math.max(action.total, hi + 1);
			return {
				...state,
				lo: state.hi < 0 ? items[0].event_index : state.lo,
				hi,
				events: [...state.events, ...items],
				total,
				newBelow: state.following ? 0 : countNewBelow(total, hi),
			};
		}

		case "noticed": {
			const total =
				action.index === null
					? state.total + 1
					: Math.max(state.total, action.index + 1);
			return { ...state, total, newBelow: countNewBelow(total, state.hi) };
		}

		case "following":
			return {
				...state,
				following: action.following,
				newBelow: action.following ? 0 : state.newBelow,
			};
	}
}

/** Whether anything older than the window exists on the server. */
export const hasOlder = (w: EventWindow) => w.hi >= 0 && w.lo > 0;
