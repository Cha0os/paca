import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWindow } = vi.hoisted(() => ({ mockWindow: vi.fn() }));

vi.mock("@/lib/api-client", () => ({
	apiClient: { instance: { get: vi.fn() } },
}));

vi.mock("@/lib/agent-api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/agent-api")>();
	return { ...actual, listConversationEventWindow: mockWindow };
});

import {
	type AgentConversationEvent,
	conversationEventsTailKey,
} from "@/lib/agent-api";
import { useConversationEventWindow } from "./use-conversation-event-window";

const PROJECT_ID = "proj-1";
const CONVERSATION_ID = "conv-1";

function ev(index: number): AgentConversationEvent {
	return {
		id: `event-${index}`,
		conversation_id: CONVERSATION_ID,
		event_index: index,
		event_type: "ACPToolCallEvent",
		event_source: "agent",
		payload: {},
		created_at: "2026-01-01T00:00:00Z",
	};
}

const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));

/** Serves `[offset, offset+limit)` plus the current total, as the API does. */
function fakeStream(initialCount: number) {
	let count = initialCount;
	mockWindow.mockImplementation(
		async (
			_projectId: string,
			_conversationId: string,
			{ offset, limit }: { offset: number; limit: number },
		) => ({
			items: range(offset, Math.min(offset + limit, count) - 1).filter(
				(e) => e.event_index < count,
			),
			total: count,
		}),
	);
	return {
		grow(by: number) {
			count += by;
			return count - 1; // highest index now present
		},
		get count() {
			return count;
		},
	};
}

function harness() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	/**
	 * What `useProjectRealtime` does per event: invalidate the conversations
	 * prefix, then write the tail signal.
	 */
	const signal = (index: number | null) =>
		act(() => {
			void queryClient.invalidateQueries({
				queryKey: ["projects", PROJECT_ID, "conversations"],
			});
			queryClient.setQueryData(
				conversationEventsTailKey(PROJECT_ID, CONVERSATION_ID),
				(prev: { tick: number; index: number | null } | undefined) => ({
					tick: (prev?.tick ?? 0) + 1,
					index,
				}),
			);
		});
	return { queryClient, wrapper, signal };
}

describe("useConversationEventWindow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("opens on the newest page rather than the whole stream", async () => {
		fakeStream(275);
		const { wrapper } = harness();

		const { result } = renderHook(
			() =>
				useConversationEventWindow({
					projectId: PROJECT_ID,
					conversationId: CONVERSATION_ID,
					eventCount: 275,
					pageSize: 200,
				}),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.events).toHaveLength(200);
		expect(result.current.events[0].event_index).toBe(75);
		expect(result.current.events.at(-1)?.event_index).toBe(274);
		expect(result.current.hasOlder).toBe(true);
	});

	it("appends events as realtime reports them", async () => {
		const stream = fakeStream(275);
		const { wrapper, signal } = harness();

		const { result } = renderHook(
			() =>
				useConversationEventWindow({
					projectId: PROJECT_ID,
					conversationId: CONVERSATION_ID,
					eventCount: 275,
					pageSize: 200,
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.events).toHaveLength(200));

		await signal(stream.grow(1));
		await waitFor(() => expect(result.current.hi).toBe(275));
		expect(result.current.events.at(-1)?.event_index).toBe(275);
	});

	it("counts rather than fetches while the reader is scrolled away", async () => {
		const stream = fakeStream(275);
		const { wrapper, signal } = harness();

		const { result } = renderHook(
			() =>
				useConversationEventWindow({
					projectId: PROJECT_ID,
					conversationId: CONVERSATION_ID,
					eventCount: 275,
					pageSize: 200,
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.events).toHaveLength(200));
		const callsAfterOpen = mockWindow.mock.calls.length;

		act(() => result.current.setFollowing(false));
		await signal(stream.grow(3));

		// Reported, not downloaded.
		await waitFor(() => expect(result.current.newBelow).toBe(3));
		expect(result.current.hi).toBe(274);
		expect(mockWindow.mock.calls.length).toBe(callsAfterOpen);

		act(() => result.current.jumpToLatest());
		await waitFor(() => expect(result.current.hi).toBe(277));
		expect(result.current.newBelow).toBe(0);
	});

	it("takes events for a conversation that was empty when opened", async () => {
		const stream = fakeStream(0);
		const { wrapper, signal } = harness();

		const { result } = renderHook(
			() =>
				useConversationEventWindow({
					projectId: PROJECT_ID,
					conversationId: CONVERSATION_ID,
					eventCount: 0,
					pageSize: 200,
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.events).toHaveLength(0);

		await signal(stream.grow(1));
		await waitFor(() => expect(result.current.events).toHaveLength(1));
		expect(result.current.hi).toBe(0);
	});

	it("catches up across a burst that outruns one window", async () => {
		const stream = fakeStream(10);
		const { wrapper, signal } = harness();

		const { result } = renderHook(
			() =>
				useConversationEventWindow({
					projectId: PROJECT_ID,
					conversationId: CONVERSATION_ID,
					eventCount: 10,
					pageSize: 5,
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.hi).toBe(9));

		// 12 new events with a 5-event page: needs three round trips.
		await signal(stream.grow(12));
		await waitFor(() => expect(result.current.hi).toBe(21), { timeout: 3000 });
		expect(result.current.total).toBe(22);
	});

	it("probes for the length when the API does not report a count", async () => {
		fakeStream(50);
		const { wrapper } = harness();

		const { result } = renderHook(
			() =>
				useConversationEventWindow({
					projectId: PROJECT_ID,
					conversationId: CONVERSATION_ID,
					eventCount: undefined,
					pageSize: 200,
				}),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.events).toHaveLength(50));
		// First call is the one-row probe, second is the window itself.
		expect(mockWindow.mock.calls[0][2]).toEqual({ offset: 0, limit: 1 });
	});

	it("holds the first window until the event count is settled", async () => {
		fakeStream(275);
		const { wrapper } = harness();

		type Props = { ready: boolean; eventCount: number | undefined };
		const initialProps: Props = { ready: false, eventCount: undefined };

		const { result, rerender } = renderHook(
			({ ready, eventCount }: Props) =>
				useConversationEventWindow({
					projectId: PROJECT_ID,
					conversationId: CONVERSATION_ID,
					eventCount,
					ready,
					pageSize: 200,
				}),
			{ wrapper, initialProps },
		);

		expect(mockWindow).not.toHaveBeenCalled();

		rerender({ ready: true, eventCount: 275 });
		await waitFor(() => expect(result.current.events).toHaveLength(200));
		// Went straight to the tail: no probe was needed.
		expect(mockWindow.mock.calls[0][2]).toEqual({ offset: 75, limit: 200 });
	});
	it("survives the realtime handler invalidating the conversations prefix", async () => {
		const stream = fakeStream(10);
		const { wrapper, queryClient, signal } = harness();

		const { result } = renderHook(
			() =>
				useConversationEventWindow({
					projectId: PROJECT_ID,
					conversationId: CONVERSATION_ID,
					eventCount: 10,
					pageSize: 200,
				}),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.hi).toBe(9));

		// The signal must sit outside the invalidated prefix.
		expect(conversationEventsTailKey(PROJECT_ID, CONVERSATION_ID)[0]).not.toBe(
			"projects",
		);

		// Several events in a row, each accompanied by the invalidation.
		for (let i = 0; i < 3; i++) {
			await signal(stream.grow(1));
		}
		await waitFor(() => expect(result.current.hi).toBe(12));

		// And the signal itself still holds what realtime wrote, rather than
		// having been refetched back to its starting value.
		const tail = queryClient.getQueryData(
			conversationEventsTailKey(PROJECT_ID, CONVERSATION_ID),
		) as { tick: number; index: number | null };
		expect(tail.tick).toBe(3);
		expect(tail.index).toBe(12);
	});
});
