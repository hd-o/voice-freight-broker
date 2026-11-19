import { useQuery } from "@tanstack/react-query";
import { callSchema, type Call } from "@voice-freight/contracts/calls";
import { requestApi } from "./account";

export function useCallAnalysis(
  userId: string | undefined,
  callId: string | null | undefined,
  enabled: boolean,
): ReturnType<typeof useQuery<Call["analysis"]>> {
  return useQuery({
    queryKey: ["private", userId, "analysis", callId],
    enabled: enabled && !!userId && !!callId,
    retry: false,
    refetchOnWindowFocus: (query): boolean =>
      !query.state.data?.retryAt || Date.parse(query.state.data.retryAt) <= Date.now(),
    refetchOnReconnect: (query): boolean =>
      !query.state.data?.retryAt || Date.parse(query.state.data.retryAt) <= Date.now(),
    refetchInterval: (query): number | false => {
      const analysis = query.state.data;

      if (analysis?.status !== "pending") {
        return false;
      }

      return analysis.retryAt
        ? Math.max(2000, Math.min(2_147_000_000, Date.parse(analysis.retryAt) - Date.now()))
        : 2000;
    },
    queryFn: async (): Promise<Call["analysis"]> =>
      callSchema.shape.analysis.parse(
        await (await requestApi(`/calls/${encodeURIComponent(callId!)}/analysis`)).json(),
      ),
  });
}
