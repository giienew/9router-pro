import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import AdminClient from "./AdminClient";

export default function AdminPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <AdminClient />
    </Suspense>
  );
}
