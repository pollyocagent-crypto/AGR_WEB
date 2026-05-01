import { redirect } from "next/navigation";

interface Props {
  searchParams: Promise<{ code?: string }>;
}

export default async function PairPage({ searchParams }: Props) {
  const { code } = await searchParams;
  if (code) {
    redirect(`/devices/add?code=${encodeURIComponent(code)}`);
  }
  redirect("/devices/add");
}
