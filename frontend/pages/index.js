import { useEffect, useState } from "react";

const API_URL =
  typeof window !== "undefined" ? "http://localhost:3000" : "http://api:3000";

export default function Home() {
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);

  async function load() {
    const res = await fetch(`${API_URL}/events`);
    setEvents(await res.json());
  }

  async function loadDetail(id) {
    const res = await fetch(`${API_URL}/events/${id}`);
    setSelected(await res.json());
  }

  async function retry(id) {
    await fetch(`${API_URL}/events/${id}/retry`, { method: "POST" });
    load();
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ fontFamily: "sans-serif", padding: 20 }}>
      <h1>Webhook Events</h1>
      <table border="1" cellPadding="6">
        <thead>
          <tr>
            <th>Event ID</th>
            <th>Type</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.event_id}>
              <td>{e.event_id}</td>
              <td>{e.type}</td>
              <td>{e.status}</td>
              <td>
                {e.attempt_count} / {e.max_attempts}
              </td>
              <td>{new Date(e.created_at).toLocaleString()}</td>
              <td>
                <button onClick={() => loadDetail(e.event_id)}>Details</button>{" "}
                {e.status === "failed_permanent" && (
                  <button onClick={() => retry(e.event_id)}>Retry</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <div style={{ marginTop: 20 }}>
          <h2>Event {selected.event.event_id}</h2>
          <pre>{JSON.stringify(selected.event, null, 2)}</pre>
          <h3>Attempts</h3>
          <table border="1" cellPadding="6">
            <thead>
              <tr>
                <th>#</th>
                <th>Worker</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Result</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {selected.attempts.map((a) => (
                <tr key={a.id}>
                  <td>{a.attempt_number}</td>
                  <td>{a.worker_id}</td>
                  <td>{new Date(a.started_at).toLocaleTimeString()}</td>
                  <td>
                    {a.finished_at
                      ? new Date(a.finished_at).toLocaleTimeString()
                      : "-"}
                  </td>
                  <td>{a.result}</td>
                  <td>{a.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
