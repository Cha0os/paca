// Hook that listens for global-agent chat events (home page / admin pages,
// no project context) and invalidates the matching React Query caches.
//
// Unlike useProjectRealtime, there is no explicit room to join here: the
// server auto-joins every connected socket into its own
// `user:<userId>:agent-chat` room at connect time (see
// services/realtime/src/server.ts), the same way it auto-joins the
// notifications room — a global chat conversation has no project to gate
// room membership on, only the caller's own identity. So this hook only
// needs to attach a listener, mirroring useProjectRealtime's event handling
// but without the join/leave/rejoin bookkeeping.
//
// Usage: call once from wherever the global AIChatFloat is mounted.
//
// `enabled` (default true) lets a component that's reused at both project
// and global scope (e.g. the Conversations page) always call this hook —
// per the rules of hooks — while only actually subscribing when it's
// rendering in global scope.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
	type ConversationEventsTail,
	conversationEventsTailKey,
} from "@/lib/agent-api";
import { connectSocket, type RealtimeEvent } from "@/lib/socket-client";

export function useGlobalAgentRealtime(enabled = true): void {
	const queryClient = useQueryClient();

	useEffect(() => {
		if (!enabled) return;
		const socket = connectSocket();

		function handleEvent(event: RealtimeEvent) {
			const { type } = event;
			if (!type.startsWith("agent.")) return;

			// Broad invalidation (not per-conversation) — matches
			// useProjectRealtime's agent.* handling; prefix-matches both the
			// single conversation and its events sub-key since TanStack Query
			// invalidates by key prefix.
			const conversationId =
				typeof event.payload.conversation_id === "string"
					? event.payload.conversation_id
					: null;
			if (conversationId) {
				// How far the stream has grown, for views holding a window of
				// events. `event_index` is absent on older API builds; the tick
				// alone still prompts a fetch, it just cannot say how many events
				// are waiting.
				const eventIndex = Number.parseInt(
					String(event.payload.event_index ?? ""),
					10,
				);
				queryClient.setQueryData(
					conversationEventsTailKey(conversationId),
					(prev: ConversationEventsTail | undefined) => ({
						tick: (prev?.tick ?? 0) + 1,
						index: Number.isFinite(eventIndex)
							? Math.max(prev?.index ?? -1, eventIndex)
							: (prev?.index ?? null),
					}),
				);
			}

			void queryClient.invalidateQueries({
				queryKey: ["global-chat", "conversations"],
			});
		}

		socket.on("event", handleEvent);
		return () => {
			socket.off("event", handleEvent);
		};
	}, [queryClient, enabled]);
}
