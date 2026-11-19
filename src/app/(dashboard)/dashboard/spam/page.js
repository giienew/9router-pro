import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import SpamRankingClient from "./SpamRankingClient";

export default function SpamPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <SpamRankingClient />
    </Suspense>
  );
}
