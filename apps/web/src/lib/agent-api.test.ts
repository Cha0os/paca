import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet } = vi.hoisted(() => ({
	mockGet: vi.fn(),
}));

vi.mock("./api-client", () => ({
	apiClient: {
		instance: {
			get: mockGet,
		},
	},
}));

import {
	CONVERSATION_EVENTS_PAGE_SIZE,
	listConversationEvents,
	listConversationEventWindow,
	listConversations,
} from "./agent-api";

const PROJECT_ID = "proj-1";
const CONVERSATION_ID = "conv-1";

function ok<T>(data: T) {
	return { data: { data, success: true } };
}

function emptyPage() {
	return ok({ items: [], page_size: 20, next_cursor: null });
}

function paramsOf(callIndex = 0) {
	const [, config] = mockGet.mock.calls[callIndex] as [
		string,
		{ params: Record<string, unknown> },
	];
	return config.params ?? {};
}

describe("agent-api", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("listConversations", () => {
		it("defaults to page_size=20 with no other params when called without options", async () => {
			mockGet.mockResolvedValue(emptyPage());

			await listConversations(PROJECT_ID);

			expect(mockGet).toHaveBeenCalledWith(
				`/projects/${PROJECT_ID}/conversations`,
				{ params: { page_size: 20 } },
			);
		});

		it("joins multi-value filters into comma-separated params", async () => {
			mockGet.mockResolvedValue(emptyPage());

			await listConversations(PROJECT_ID, {
				agentIds: ["agent-a", "agent-b"],
				statuses: ["running", "paused"],
				triggerTypes: ["task_assigned", "chat_message"],
			});

			const params = paramsOf();
			expect(params.agent_id).toBe("agent-a,agent-b");
			expect(params.status).toBe("running,paused");
			expect(params.trigger_type).toBe("task_assigned,chat_message");
		});

		it("omits array params when the array is empty", async () => {
			mockGet.mockResolvedValue(emptyPage());

			await listConversations(PROJECT_ID, {
				agentIds: [],
				statuses: [],
				triggerTypes: [],
			});

			const params = paramsOf();
			expect(params.agent_id).toBeUndefined();
			expect(params.status).toBeUndefined();
			expect(params.trigger_type).toBeUndefined();
		});

		it("converts createdAfter/createdBefore to UTC-instant boundaries of the local day", async () => {
			mockGet.mockResolvedValue(emptyPage());

			await listConversations(PROJECT_ID, {
				createdAfter: "2026-01-01",
				createdBefore: "2026-01-31",
			});

			// Computed the same way the implementation does (local Y/M/D ->
			// Date -> ISO) rather than hardcoding a UTC string, so this test
			// is correct regardless of the runner's local timezone.
			const wantAfter = new Date(2026, 0, 1, 0, 0, 0, 0).toISOString();
			const wantBefore = new Date(2026, 0, 31 + 1, 0, 0, 0, 0).toISOString();

			const params = paramsOf();
			expect(params.created_after).toBe(wantAfter);
			expect(params.created_before).toBe(wantBefore);
		});

		it("trims the search param and omits it when blank", async () => {
			mockGet.mockResolvedValue(emptyPage());

			await listConversations(PROJECT_ID, { search: "  login bug  " });
			expect(paramsOf().search).toBe("login bug");

			mockGet.mockClear();
			mockGet.mockResolvedValue(emptyPage());
			await listConversations(PROJECT_ID, { search: "   " });
			expect(paramsOf().search).toBeUndefined();
		});

		it("forwards cursor and a custom pageSize", async () => {
			mockGet.mockResolvedValue(emptyPage());

			await listConversations(PROJECT_ID, {
				cursor: "opaque-cursor",
				pageSize: 50,
			});

			const params = paramsOf();
			expect(params.cursor).toBe("opaque-cursor");
			expect(params.page_size).toBe(50);
		});
	});

	describe("listConversationEvents", () => {
		function eventPage(startIndex: number, count: number, total: number) {
			return ok({
				items: Array.from({ length: count }, (_, i) => ({
					id: `event-${startIndex + i}`,
					conversation_id: CONVERSATION_ID,
					event_index: startIndex + i,
					event_type: "ACPToolCallEvent",
					event_source: "agent",
					payload: {},
					created_at: "2026-01-01T00:00:00Z",
				})),
				total,
			});
		}

		it("issues a single request when the stream fits in one page", async () => {
			mockGet.mockResolvedValueOnce(eventPage(0, 12, 12));

			const events = await listConversationEvents(PROJECT_ID, CONVERSATION_ID);

			expect(mockGet).toHaveBeenCalledTimes(1);
			expect(paramsOf()).toEqual({
				limit: CONVERSATION_EVENTS_PAGE_SIZE,
				offset: 0,
			});
			expect(events).toHaveLength(12);
		});

		it("pages through a stream longer than the server's limit", async () => {
			mockGet
				.mockResolvedValueOnce(eventPage(0, 200, 450))
				.mockResolvedValueOnce(eventPage(200, 200, 450))
				.mockResolvedValueOnce(eventPage(400, 50, 450));

			const events = await listConversationEvents(PROJECT_ID, CONVERSATION_ID);

			expect(mockGet).toHaveBeenCalledTimes(3);
			expect(paramsOf(0).offset).toBe(0);
			expect(paramsOf(1).offset).toBe(200);
			expect(paramsOf(2).offset).toBe(400);
			// Every event, still in ascending event_index order.
			expect(events).toHaveLength(450);
			expect(events[0].event_index).toBe(0);
			expect(events.at(-1)?.event_index).toBe(449);
		});

		it("stops on a short page even when total overstates what is available", async () => {
			mockGet.mockResolvedValueOnce(eventPage(0, 10, 999));

			const events = await listConversationEvents(PROJECT_ID, CONVERSATION_ID);

			expect(mockGet).toHaveBeenCalledTimes(1);
			expect(events).toHaveLength(10);
		});

		it("tolerates a response without a total", async () => {
			mockGet.mockResolvedValueOnce(ok({ items: [] }));

			const events = await listConversationEvents(PROJECT_ID, CONVERSATION_ID);

			expect(mockGet).toHaveBeenCalledTimes(1);
			expect(events).toEqual([]);
		});
	});
	describe("listConversationEventWindow", () => {
		it("requests exactly the window it was asked for", async () => {
			mockGet.mockResolvedValueOnce(ok({ items: [], total: 900 }));

			const page = await listConversationEventWindow(
				PROJECT_ID,
				CONVERSATION_ID,
				{ offset: 700, limit: 200 },
			);

			expect(mockGet).toHaveBeenCalledWith(
				`/projects/${PROJECT_ID}/conversations/${CONVERSATION_ID}/events`,
				{ params: { limit: 200, offset: 700 } },
			);
			expect(page.total).toBe(900);
		});

		it("infers a total from the window when the API omits one", async () => {
			mockGet.mockResolvedValueOnce(
				ok({ items: [{ event_index: 10 }, { event_index: 11 }] }),
			);

			const page = await listConversationEventWindow(
				PROJECT_ID,
				CONVERSATION_ID,
				{ offset: 10, limit: 200 },
			);

			// Offset plus what came back is the least it can be.
			expect(page.total).toBe(12);
			expect(page.items).toHaveLength(2);
		});
	});
});
