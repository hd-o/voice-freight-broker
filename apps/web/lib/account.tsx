"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { identitySchema, errorSchema, type Identity } from "@voice-freight/contracts/business";
import { AccountPanel } from "@/components/navigation/account-panel";
import { AlertDialog } from "@/components/ui/alert-dialog";

const accountContext = createContext<{
  user: Identity | null;
  loading: boolean;
  pending: boolean;
  notice?: string;
  performAccountAction: () => void;
}>({
  user: null,
  loading: false,
  pending: false,
  performAccountAction: (): void => {},
});
const accountKey = "freight-local-session";
const sessionLock = "freight-session-mutation";

export async function requestApi(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  }).catch((): never => {
    throw new Error("Local API unavailable. Start the local workers and apply migrations, then try again.");
  });

  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new Event("freight-session-expired"));
    }

    const error = errorSchema.safeParse(await response.json().catch((): null => null));

    throw new Error(
      response.status === 401
        ? "Session expired. Sign in again."
        : error.success
          ? error.data.error.message
          : "Local API unavailable. Start the local workers and apply migrations, then try again.",
    );
  }

  return response;
}

async function fetchIdentity(): Promise<{ user: Identity | null; identities: Identity[] }> {
  const data: { user: unknown; identities: unknown[] } = await (await requestApi("/identity")).json();

  return {
    user: data.user === null ? null : identitySchema.parse(data.user),
    identities: data.identities.map((identity): Identity => identitySchema.parse(identity)),
  };
}

export function AccountProvider({ children }: { children: ReactNode }): ReactElement {
  const cache = useQueryClient();
  const [session, setSession] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [panel, setPanel] = useState(false);
  const [operation, setOperation] = useState<"sign-in" | "sign-out" | "waiting" | null>(null);
  const [notice, setNotice] = useState<string>();
  const mutation = useRef(false);
  const pending = operation !== null;

  const progress =
    operation === "sign-in"
      ? "Signing in…"
      : operation === "sign-out"
        ? "Signing out…"
        : operation === "waiting"
          ? "Another account change is finishing. Try again when it completes."
          : undefined;

  const identity = useQuery({
    queryKey: ["identity", session],
    queryFn: fetchIdentity,
    enabled: !!session || panel,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });

  const user = session ? (identity.data?.user ?? null) : null;

  useEffect((): void | (() => void) => {
    setSession(localStorage.getItem(accountKey));
    setRestored(true);

    function expireSession(): void {
      cache.clear();
      localStorage.removeItem(accountKey);
      setSession(null);
      setNotice("Session expired. Sign in again.");
    }

    function synchronizeAccount(): void {
      cache.clear();
      setSession(localStorage.getItem(accountKey));
    }

    function restoreAccount(event: PageTransitionEvent): void {
      if (!event.persisted) {
        return;
      }

      cache.removeQueries({ queryKey: ["private"] });
      void cache.resetQueries({ queryKey: ["identity"] });
      setSession(localStorage.getItem(accountKey));
    }

    window.addEventListener("freight-session-expired", expireSession);
    window.addEventListener("storage", synchronizeAccount);
    window.addEventListener("pageshow", restoreAccount);

    return (): void => {
      window.removeEventListener("freight-session-expired", expireSession);
      window.removeEventListener("storage", synchronizeAccount);
      window.removeEventListener("pageshow", restoreAccount);
    };
  }, [cache]);

  useEffect((): void | (() => void) => {
    if (session && identity.data?.user === null) {
      cache.removeQueries({ queryKey: ["private"] });
      localStorage.removeItem(accountKey);
      setSession(null);
    }
  }, [session, identity.data, cache]);

  async function mutateSession(action: "sign-in" | "sign-out", command: () => Promise<void>): Promise<void> {
    if (mutation.current) {
      return;
    }

    if (!navigator.locks) {
      setNotice("Local accounts require browser Web Locks. Use desktop Chrome on localhost or HTTPS.");
      return;
    }

    mutation.current = true;
    setOperation(action);
    setNotice(undefined);

    try {
      const completed = await navigator.locks.request(
        sessionLock,
        { ifAvailable: true },
        async (lock): Promise<boolean> => {
          if (!lock) {
            return false;
          }

          await command();
          return true;
        },
      );

      if (!completed) {
        setOperation("waiting");
        // Observe release without queuing the user's account choice.
        await navigator.locks.request(sessionLock, (): void => {});
      }
    } catch (error) {
      setNotice(
        action === "sign-out"
          ? "Private data cleared. Server sign-out failed; retry when the local API is available."
          : error instanceof Error
            ? error.message
            : "Sign-in failed.",
      );
    } finally {
      mutation.current = false;
      setOperation(null);
    }
  }

  async function signIn(id: string): Promise<void> {
    await mutateSession("sign-in", async (): Promise<void> => {
      cache.removeQueries({ queryKey: ["private"] });
      await requestApi("/session", "POST", { userId: id });
      const marker = crypto.randomUUID();
      localStorage.setItem(accountKey, marker);
      cache.clear();
      setSession(marker);
      setPanel(false);
    });
  }

  async function signOut(): Promise<void> {
    await mutateSession("sign-out", async (): Promise<void> => {
      setSession(null);
      localStorage.removeItem(accountKey);
      cache.clear();
      await requestApi("/session", "DELETE");
    });
  }

  function performAccountAction(): void {
    if (mutation.current) {
      return;
    }

    if (user) {
      void signOut();
    } else {
      setPanel(true);
      void identity.refetch();
    }
  }

  return (
    <accountContext.Provider
      value={{
        user,
        loading: !restored || (!!session && identity.isPending),
        pending,
        notice: progress ?? notice,
        performAccountAction,
      }}
    >
      {children}
      <AlertDialog open={panel} onOpenChange={setPanel}>
        <AccountPanel
          identities={identity.data?.identities ?? []}
          pending={pending || identity.isFetching}
          progress={progress}
          error={pending ? undefined : (notice ?? identity.error?.message)}
          onSignIn={(id): void => {
            void signIn(id);
          }}
        />
      </AlertDialog>
    </accountContext.Provider>
  );
}

export function useAccount(): {
  user: Identity | null;
  loading: boolean;
  pending: boolean;
  notice?: string;
  performAccountAction: () => void;
} {
  return useContext(accountContext);
}
