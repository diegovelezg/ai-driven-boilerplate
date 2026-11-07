import { redirect } from "next/navigation";

// La ficha vive en el drawer del listado; esta ruta solo redirige
// (deep links y bookmarks antiguos siguen funcionando).
export default async function EmpresaRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/companies?company=${encodeURIComponent(id)}`);
}
