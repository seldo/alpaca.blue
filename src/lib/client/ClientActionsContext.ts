"use client";

import { createContext, useContext } from "react";
import type { ClientPost } from "./types";

// Provided by the client-pipeline timeline so PostCard can perform writes
// directly (browser → platform) instead of hitting the server write routes.
// When this context is null (the production /timeline), PostCard falls back to
// its existing server-route behaviour — so production is unaffected.
export interface ClientActions {
  like: (post: ClientPost) => Promise<{ viewerLiked: boolean; likeCount: number }>;
  repost: (post: ClientPost) => Promise<{ viewerReposted: boolean; repostCount: number }>;
}

export const ClientActionsContext = createContext<ClientActions | null>(null);

export function useClientActions(): ClientActions | null {
  return useContext(ClientActionsContext);
}
