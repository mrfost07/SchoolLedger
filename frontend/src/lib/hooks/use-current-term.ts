"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchTerms } from "@/lib/api/endpoints";
import type { TermRow } from "@/lib/api/types";

export function useTerms() {
  return useQuery({
    queryKey: ["terms"],
    queryFn: fetchTerms,
    staleTime: 5 * 60_000,
  });
}

export function pickCurrentTerm(terms: TermRow[]): TermRow | null {
  const ordered = [...terms].sort(
    (left, right) => new Date(right.startsAt).getTime() - new Date(left.startsAt).getTime(),
  );
  return (
    ordered.find((term) => term.status === "ENROLLMENT") ??
    ordered.find((term) => term.status === "ADD_DROP") ??
    ordered[0] ??
    null
  );
}

export function useCurrentTerm() {
  const query = useTerms();
  return {
    ...query,
    term: query.data ? pickCurrentTerm(query.data) : null,
  };
}
