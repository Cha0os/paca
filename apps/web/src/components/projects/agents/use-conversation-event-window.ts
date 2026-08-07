import { useQuery } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import {
	type AgentConversationEvent,
	CONVERSATION_EVENTS_PAGE_SIZE,
	conversationEventsTailQueryOptions,
	listConversationEventWindow,
} from "@/lib/agent-api";
import {
	type EventWindow,
	emptyEventWindow,
	eventWindowReducer,
	hasOlder as windowHasOlder,
} from "./event-window";

export type UseConversationEventWindow = {
	events: AgentConversationEvent[];
	/** True until the first window has been fetched. */
	isLoading: boolean;
	hasOlder: boolean;
	isLoadingOlder: boolean;
	loadOlder: () => void;
	/** Events waiting past the window while not following. */
	newBelow: number;
	following: boolean;
	setFollowing: (following: boolean) => void;
	jumpToLatest: () => void;
	lo: number;
	hi: number;
	total: number;
};

/**
 * Keeps a contiguous window of a conversation's events, anchored at the tail.
 *
 * Opens on the newest `pageSize` events and extends upwards on demand. While
 * following, only the events past the window are fetched; while not following,
 * they are counted and left on the server.
 */
export function useConversationEventWindow({
	projectId,
	conversationId,
	eventCount,
	/** Holds the first window until `eventCount` is settled, avoiding a probe. */
	ready = true,
	pageSize = CONVERSATION_EVENTS_PAGE_SIZE,
}: {
	projectId: string;
	conversationId: string;
	/** From the conversation itself; undefined on an API without the field. */
	eventCount: number | undefined;
	ready?: boolean;
	pageSize?: number;
}): UseConversationEventWindow {
	const [state, dispatch] = useReducer(eventWindowReducer, emptyEventWindow);
	const [isLoading, setIsLoading] = useState(true);
	const [isLoadingOlder, setIsLoadingOlder] = useState(false);

	// Guards every fetch so a stale response cannot land in the current window.
	const runIdRef = useRef(0);
	const inFlightRef = useRef(false);
	const stateRef = useRef(state);
	stateRef.current = state;
	// Read, never depended on: it grows while the conversation runs, and the
	// initial load must run once per conversation.
	const eventCountRef = useRef(eventCount);
	eventCountRef.current = eventCount;

	const { data: tail } = useQuery(
		conversationEventsTailQueryOptions(projectId, conversationId),
	);

	// Initial window, and the reset point for a conversation switch.
	useEffect(() => {
		const runId = runIdRef.current + 1;
		runIdRef.current = runId;
		inFlightRef.current = false;
		dispatch({ type: "reset" });
		setIsLoading(true);
		setIsLoadingOlder(false);

		if (!ready) return;
		const isStale = () => runId !== runIdRef.current;

		(async () => {
			try {
				let total = eventCountRef.current;
				if (typeof total !== "number") {
					// One row, for its `total`.
					const probe = await listConversationEventWindow(
						projectId,
						conversationId,
						{ offset: 0, limit: 1 },
					);
					if (isStale()) return;
					total = probe.total;
				}
				if (total === 0) {
					dispatch({ type: "loaded", items: [], total: 0 });
					return;
				}
				const page = await listConversationEventWindow(
					projectId,
					conversationId,
					{ offset: Math.max(0, total - pageSize), limit: pageSize },
				);
				if (isStale()) return;
				dispatch({ type: "loaded", items: page.items, total: page.total });
			} finally {
				if (!isStale()) setIsLoading(false);
			}
		})();
	}, [projectId, conversationId, pageSize, ready]);

	const loadOlder = useCallback(() => {
		const runId = runIdRef.current;
		const { lo } = stateRef.current;
		if (inFlightRef.current || lo <= 0) return;
		inFlightRef.current = true;
		setIsLoadingOlder(true);

		(async () => {
			try {
				const limit = Math.min(pageSize, lo);
				const page = await listConversationEventWindow(
					projectId,
					conversationId,
					{ offset: lo - limit, limit },
				);
				if (runId !== runIdRef.current) return;
				dispatch({ type: "prepended", items: page.items, total: page.total });
			} finally {
				if (runId === runIdRef.current) setIsLoadingOlder(false);
				inFlightRef.current = false;
			}
		})();
	}, [projectId, conversationId, pageSize]);

	/** Pull in whatever exists past `hi`, one window at a time. */
	const syncTail = useCallback(() => {
		const runId = runIdRef.current;
		if (inFlightRef.current) return;
		const { hi, total } = stateRef.current;
		// `hi + 1` is both the next index to fetch and the count already loaded,
		// so an empty window (hi -1) needs no special case.
		if (hi + 1 >= total) return;
		inFlightRef.current = true;

		(async () => {
			try {
				const page = await listConversationEventWindow(
					projectId,
					conversationId,
					{ offset: hi + 1, limit: pageSize },
				);
				if (runId !== runIdRef.current) return;
				dispatch({ type: "appended", items: page.items, total: page.total });
			} finally {
				inFlightRef.current = false;
			}
		})();
	}, [projectId, conversationId, pageSize]);

	// One signal per persisted event; the effect below does the fetching, so a
	// burst collapses into as few range requests as possible.
	useEffect(() => {
		if (!tail || tail.tick === 0 || isLoading) return;
		dispatch({ type: "noticed", index: tail.index });
	}, [tail, isLoading]);

	// Single path that closes a gap: realtime signal, a burst that landed
	// mid-flight, an empty initial window, or resuming follow.
	useEffect(() => {
		if (isLoading || !state.following) return;
		if (state.hi + 1 < state.total) syncTail();
	}, [isLoading, state.following, state.hi, state.total, syncTail]);

	const setFollowing = useCallback((following: boolean) => {
		dispatch({ type: "following", following });
	}, []);

	const jumpToLatest = useCallback(() => {
		dispatch({ type: "following", following: true });
	}, []);

	return useMemo(
		() => ({
			events: state.events,
			isLoading,
			hasOlder: windowHasOlder(state),
			isLoadingOlder,
			loadOlder,
			newBelow: state.newBelow,
			following: state.following,
			setFollowing,
			jumpToLatest,
			lo: state.lo,
			hi: state.hi,
			total: state.total,
		}),
		[state, isLoading, isLoadingOlder, loadOlder, setFollowing, jumpToLatest],
	) satisfies UseConversationEventWindow;
}

export type { EventWindow };
