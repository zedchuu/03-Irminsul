import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { GoalSummary } from "@/types/database.types";

export default async function Page() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  let goals: GoalSummary[] = [];
  let fetchError: string | null = null;

  try {
    const { data, error } = await supabase
      .from("goals")
      .select("id, title, slug, description, last_verified_at, access_count, created_at, updated_at");

    if (error) {
      fetchError = error.message;
    } else {
      goals = data ?? [];
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "An unexpected error occurred.";
  }

  return (
    <main style={{ fontFamily: "monospace", padding: "2rem", maxWidth: "800px" }}>
      <h1>Irminsul — Backend Smoke Test</h1>
      <p style={{ color: "#666" }}>
        Server Component · Supabase SSR · Table: <code>goals</code>
      </p>
      <hr />

      {/* ── Case 1: Fetch error ── */}
      {fetchError && (
        <div
          style={{
            border: "1px solid red",
            borderRadius: "4px",
            padding: "1rem",
            marginTop: "1rem",
            color: "red",
          }}
        >
          <strong>Supabase Error</strong>
          <pre style={{ margin: "0.5rem 0 0", whiteSpace: "pre-wrap" }}>{fetchError}</pre>
        </div>
      )}

      {/* ── Case 2: Connection OK, table empty ── */}
      {!fetchError && goals.length === 0 && (
        <p style={{ marginTop: "1rem", color: "green" }}>
          ✓ Connection successful: Table is empty.
        </p>
      )}

      {/* ── Case 3: Data returned ── */}
      {!fetchError && goals.length > 0 && (
        <>
          <p style={{ marginTop: "1rem", color: "green" }}>
            ✓ Connection successful: {goals.length} row{goals.length !== 1 ? "s" : ""} returned.
          </p>
          <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
            {goals.map((goal) => (
              <li
                key={goal.id}
                style={{
                  borderBottom: "1px solid #ddd",
                  paddingBottom: "1rem",
                  marginBottom: "1rem",
                }}
              >
                <div><strong>title:</strong> {goal.title}</div>
                <div><strong>description:</strong> {goal.description ?? <em>null</em>}</div>
                <div><strong>created_at:</strong> {goal.created_at}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}