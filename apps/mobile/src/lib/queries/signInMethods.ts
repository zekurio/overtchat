import { useQuery } from "@tanstack/react-query";
import type { SignInMethods } from "@overtchat/shared";
import { getApiBase } from "@/lib/api";
import { queryKeys } from "./keys";

const PASSWORD_ONLY: SignInMethods = { password: true, sso: null };

/**
 * How the signed-in server signs users in. Servers from before single sign-on
 * have no endpoint and offer passwords only.
 */
export function useSignInMethods() {
  const server = getApiBase();
  return useQuery({
    queryKey: queryKeys.signInMethods(server),
    queryFn: async (): Promise<SignInMethods> => {
      const response = await fetch(new URL("/api/sign-in-methods", server).toString(), {
        credentials: "omit",
      });
      if (response.status === 404) return PASSWORD_ONLY;
      if (!response.ok) throw new Error("Could not load sign-in methods.");
      return (await response.json()) as SignInMethods;
    },
    staleTime: 60_000,
  });
}
