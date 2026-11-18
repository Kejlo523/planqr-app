export interface ZutTeacher {
  id: string;
  name: string;
}

export async function findZutTeachers(query: string, signal?: AbortSignal): Promise<ZutTeacher[]> {
  const search = new URLSearchParams({ kind: "teacher", query: query.trim() });
  const response = await fetch("/schedule.php?" + search.toString(), { signal });
  if (!response.ok) throw new Error("Wyszukiwanie w Planie ZUT jest chwilowo niedostępne.");
  const data: unknown = await response.json();
  if (!Array.isArray(data)) return [];
  const teachers = new Map<string, ZutTeacher>();
  for (const item of data) {
    const name = typeof item?.item === "string" ? item.item.trim() : "";
    if (!name) continue;
    const id = typeof item.id === "number" || typeof item.id === "string" ? String(item.id) : name;
    if (id) teachers.set(id, { id, name });
  }
  return [...teachers.values()];
}
