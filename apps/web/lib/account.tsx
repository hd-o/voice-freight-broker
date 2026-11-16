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
const accountChangeKey = "freight-account-change";

export async function requestApi(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  }).catch((): never => {
    throw new Error("Service unavailable. Please try again shortly.");
  });

  if (!response.ok || response.redirected || !response.headers.get("Content-Type")?.includes("application/json")) {
    if (response.status === 401 || response.status === 403 || response.redirected) {
      window.dispatchEvent(new Event("freight-session-expired"));
    }

    const error = errorSchema.safeParse(await response.json().catch((): null => null));

    throw new Error(
      response.status === 401 || response.redirected
        ? "Session expired. Sign in again."
        : error.success
          ? error.data.error.message
          : "Service unavailable. Please try again shortly.",
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
  const [mode, setMode] = useState<"local" | "access">("local");
  const [configuration, setConfiguration] = useState(false);
  const [session, setSession] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [panel, setPanel] = useState(false);
  const [operation, setOperation] = useState<"sign-in" | "sign-out" | "waiting" | null>(null);
  const [notice, setNotice] = useState<string>();
  const mutation = useRef(false);
  const previousIdentity = useRef<string | null>(null);
  const loginReturn = useRef(false);
  const [signedOut, setSignedOut] = useState(false);
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
    queryKey: ["identity", mode, session],
    queryFn: async (): ReturnType<typeof fetchIdentity> => {
      if (mode === "local") {
        return fetchIdentity();
      }

      const response = await fetch("/auth/identity", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        throw new Error(
          response.status === 403
            ? "This account has not been invited to the demo."
            : "Account service unavailable. Try again shortly.",
        );
      }

      const data: { user: unknown } = await response.json();
      return { user: data.user === null ? null : identitySchema.parse(data.user), identities: [] };
    },
    enabled: configuration && !signedOut && (mode === "access" || !!session || panel),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });

  const user = !signedOut && !identity.isError && (mode === "access" || session) ? (identity.data?.user ?? null) : null;

  useEffect((): void => {
    const id = user?.id ?? null;

    if (previousIdentity.current && previousIdentity.current !== id) {
      cache.removeQueries({ queryKey: ["private", previousIdentity.current] });
    }

    previousIdentity.current = id;

    if (mode === "access" && id && loginReturn.current) {
      loginReturn.current = false;
      localStorage.setItem(accountChangeKey, `signed-in:${crypto.randomUUID()}`);
    }
  }, [user?.id, mode, cache]);

  useEffect((): void | (() => void) => {
    setSession(localStorage.getItem(accountKey));
    const location = new URL(window.location.href);
    loginReturn.current ||= location.searchParams.get("account") === "signed-in";

    if (loginReturn.current) {
      location.searchParams.delete("account");
      window.history.replaceState(window.history.state, "", location.pathname + location.search + location.hash);
    }

    setRestored(true);
    const controller = new AbortController();

    void fetch("/auth/configuration", {
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    })
      .then(async (response): Promise<void> => {
        if (response.ok && response.headers.get("Content-Type")?.includes("application/json")) {
          const data: { mode?: string } = await response.json();
          setMode(data.mode === "access" ? "access" : "local");
          setSignedOut(
            data.mode === "access" &&
              !loginReturn.current &&
              localStorage.getItem(accountChangeKey)?.startsWith("signed-out:") === true,
          );
        }
      })
      .catch((): void => {})
      .finally((): void => {
        if (!controller.signal.aborted) {
          setConfiguration(true);
        }
      });

    function expireSession(): void {
      cache.clear();
      localStorage.removeItem(accountKey);
      setSession(null);
      setNotice("Session expired. Sign in again.");
      void cache.resetQueries({ queryKey: ["identity"] });
    }

    function synchronizeAccount(event: StorageEvent): void {
      if (event.key !== accountKey && event.key !== accountChangeKey && event.key !== null) {
        return;
      }

      cache.clear();

      if (event.key === accountChangeKey) {
        setSignedOut(event.newValue?.startsWith("signed-out:") === true);
      } else if (event.key === accountKey && event.newValue) {
        setSignedOut(false);
      }

      setSession(localStorage.getItem(accountKey));
    }

    function restoreAccount(event: PageTransitionEvent): void {
      if (!event.persisted) {
        return;
      }

      cache.removeQueries({ queryKey: ["private"] });
      setSignedOut(localStorage.getItem(accountChangeKey)?.startsWith("signed-out:") === true);
      void cache.resetQueries({ queryKey: ["identity"] });
      setSession(localStorage.getItem(accountKey));
    }

    window.addEventListener("freight-session-expired", expireSession);
    window.addEventListener("storage", synchronizeAccount);
    window.addEventListener("pageshow", restoreAccount);

    return (): void => {
      controller.abort();
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
          ? "Private data cleared. Server sign-out failed; retry when the service is available."
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
      setSignedOut(false);
      const marker = crypto.randomUUID();
      localStorage.setItem(accountKey, marker);
      localStorage.setItem(accountChangeKey, `signed-in:${crypto.randomUUID()}`);
      cache.clear();
      setSession(marker);
      setPanel(false);
    });
  }

  async function signOut(): Promise<void> {
    await mutateSession("sign-out", async (): Promise<void> => {
      setSignedOut(true);
      localStorage.setItem(accountChangeKey, `signed-out:${crypto.randomUUID()}`);
      setSession(null);
      localStorage.removeItem(accountKey);
      cache.clear();
      try {
        await requestApi("/session", "DELETE");
      } finally {
        // A lost revocation response must not leave a revoked Access cookie
        // blocking the next login. Cloudflare cleanup is required either way.
        if (mode === "access") {
          window.location.assign(
            `/cdn-cgi/access/logout?returnTo=${encodeURIComponent(window.location.origin + "/call")}`,
          );
        }
      }
    });
  }

  function performAccountAction(): void {
    if (mutation.current) {
      return;
    }

    if (user) {
      void signOut();
    } else if (mode === "access") {
      void mutateSession("sign-in", async (): Promise<void> => {
        cache.clear();
        window.location.assign(
          `/api/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`,
        );
      });
    } else {
      setSignedOut(false);
      setPanel(true);
      void identity.refetch();
    }
  }

  return (
    <accountContext.Provider
      value={{
        user,
        loading: !restored || !configuration || (!signedOut && (mode === "access" || !!session) && identity.isPending),
        pending,
        notice: progress ?? notice ?? (mode === "access" ? identity.error?.message : undefined),
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
