import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import type { OnMount } from "@monaco-editor/react";
import * as Y from "yjs";
import type { MonacoBinding } from "y-monaco";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { api, establishSession, getAccessToken, restoreSession, setAccessToken, wsUrl, type Room, type RunOutput, type User } from "./api";

const Editor = lazy(() => import("@monaco-editor/react"));

function useSession() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { restoreSession().then(async (token) => {
    if (token) {
      try { const result = await api<{ user: User }>("/auth/me"); setUser(result.user); } catch { setAccessToken(null); }
    }
    setReady(true);
  }); }, []);
  return { user, setUser, ready };
}

export function App() {
  const session = useSession();
  const navigate = useNavigate();
  const logout = async () => {
    try { await api("/auth/logout", { method: "POST" }); } finally { setAccessToken(null); session.setUser(null); navigate("/login"); }
  };
  if (!session.ready) return <div className="loading-screen"><span className="brand-mark">⌘</span><span>Waking the workspace…</span></div>;
  return <Routes>
    <Route path="/login" element={session.user ? <Navigate to="/" replace /> : <AuthPage onSession={session.setUser} mode="login" />} />
    <Route path="/register" element={session.user ? <Navigate to="/" replace /> : <AuthPage onSession={session.setUser} mode="register" />} />
    <Route path="/join/:token" element={<JoinRoute signedIn={Boolean(session.user)} />} />
    <Route path="/rooms/:roomId" element={session.user ? <RoomPage user={session.user} onLogout={logout} /> : <Navigate to="/login" replace />} />
    <Route path="/" element={session.user ? <Dashboard user={session.user} onLogout={logout} /> : <Navigate to="/login" replace />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}

function JoinRoute({ signedIn }: { signedIn: boolean }) {
  const { token = "" } = useParams();
  if (!signedIn) {
    sessionStorage.setItem("pendingInvite", token);
    return <Navigate to="/login" replace />;
  }
  sessionStorage.removeItem("pendingInvite");
  return <JoinPage />;
}

function AuthPage({ mode, onSession }: { mode: "login" | "register"; onSession: (user: User) => void }) {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(""); setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      const result = await establishSession(`/auth/${mode}` as "/auth/login" | "/auth/register", {
        email: data.get("email"), password: data.get("password"), ...(mode === "register" ? { displayName: data.get("displayName") } : {}),
      });
      onSession(result.user);
      const pendingInvite = sessionStorage.getItem("pendingInvite");
      sessionStorage.removeItem("pendingInvite");
      navigate(pendingInvite ? `/join/${encodeURIComponent(pendingInvite)}` : "/");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not sign in"); }
    finally { setBusy(false); }
  };
  return <main className="auth-layout">
    <section className="auth-promo"><Link to="/" className="wordmark"><span className="brand-mark">⌘</span> codesync</Link><div className="promo-copy"><div className="eyebrow"><span className="live-dot" /> A calmer way to pair</div><h1>Good code<br /><em>happens together.</em></h1><p>A shared editor, live cursors, and an instant runner. Bring your team into one room and make the next idea real.</p><div className="promo-code"><span className="code-line"><i>01</i> const idea = await buildTogether();</span><span className="code-line"><i>02</i> <b>idea.ship();</b><span className="cursor-blink" /></span><span className="code-presence"><span className="avatar avatar-lilac">A</span><span className="avatar avatar-mint">J</span><span className="presence-label">your team is here</span></span></div></div><div className="promo-foot"><span>REAL-TIME COLLABORATION</span><span>BUILT FOR THE FLOW STATE</span></div></section>
    <section className="auth-side"><div className="auth-card"><div className="mobile-brand"><span className="brand-mark">⌘</span> codesync</div><div className="eyebrow muted">YOUR SHARED WORKSPACE</div><h2>{mode === "login" ? "Welcome back" : "Create your account"}</h2><p className="form-intro">{mode === "login" ? "Pick up right where your team left off." : "Make a room and start building together."}</p>
      <form onSubmit={submit} className="stack-form">
        {mode === "register" && <label>Display name<input name="displayName" placeholder="How should we call you?" required maxLength={80} /></label>}
        <label>Email address<input name="email" type="email" placeholder="you@company.com" required autoComplete="email" /></label>
        <label>Password<input name="password" type="password" placeholder={mode === "register" ? "At least 10 characters" : "Your password"} required minLength={mode === "register" ? 10 : 1} autoComplete={mode === "register" ? "new-password" : "current-password"} /></label>
        {error && <div className="error-banner">{error}</div>}
        <button className="primary-button" disabled={busy}>{busy ? "One moment…" : mode === "login" ? "Sign in" : "Create account"}<span>↗</span></button>
      </form>
      <div className="auth-switch">{mode === "login" ? <>New to CodeSync? <Link to="/register">Create an account</Link></> : <>Already have an account? <Link to="/login">Sign in</Link></>}</div>
      <div className="secure-note"><span>◈</span> Private rooms. Your code stays yours.</div>
    </div></section>
  </main>;
}

function Header({ user, onLogout, section }: { user: User; onLogout: () => void; section: string }) {
  return <header className="topbar"><Link to="/" className="wordmark"><span className="brand-mark">⌘</span> codesync</Link><div className="breadcrumbs"><span className="crumb-slash">/</span>{section}</div><div className="topbar-right"><span className="global-status"><span className="live-dot" /> ALL SYSTEMS GO</span><button className="user-chip" onClick={onLogout} title="Sign out"><span className="avatar avatar-lilac">{user.displayName.slice(0, 1).toUpperCase()}</span><span>{user.displayName}</span><span className="chevron">⌄</span></button></div></header>;
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState("");
  const navigate = useNavigate();
  const load = useCallback(async () => { const result = await api<{ rooms: Room[] }>("/rooms"); setRooms(result.rooms); }, []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); if (!name.trim()) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ room: Room; inviteToken: string }>("/rooms", { method: "POST", body: JSON.stringify({ name }) });
      setInvite(`${location.origin}/join/${result.inviteToken}`); setName(""); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create room"); }
    finally { setBusy(false); }
  };
  const copyInvite = async () => { await navigator.clipboard.writeText(invite); setInvite("Copied! Share the room link"); setTimeout(() => setInvite(""), 2500); };
  const shortDate = (date?: string) => date ? new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Just now";
  return <div className="app-shell"><Header user={user} onLogout={onLogout} section="Your rooms" /><main className="dashboard-main">
    <div className="dash-heading"><div><div className="eyebrow muted">MONDAY, YOUR WAY</div><h1>Good to have you, {user.displayName.split(" ")[0]}<span className="wave">✳</span></h1><p>Pick up a thread or open a fresh room to think out loud.</p></div><div className="dash-heading-note"><span className="note-mark">✳</span><span>Ideas are better<br />when shared.</span></div></div>
    <div className="dash-columns"><section className="rooms-section"><div className="section-heading"><div><span className="section-kicker">YOUR SPACES</span><h2>Recent rooms <span className="count-pill">{rooms.length}</span></h2></div><span className="section-caption">Everything you’re working on</span></div>
      {error && <div className="error-banner">{error}</div>}
      {rooms.length ? <div className="room-list">{rooms.map((room, index) => <button className="room-row" key={room.id} onClick={() => navigate(`/rooms/${room.id}`)}><span className={`room-icon icon-${index % 4}`}>{room.name.trim().slice(0, 1).toUpperCase()}</span><span className="room-info"><strong>{room.name}</strong><small><span className="language-dot" /> {room.ownerId === user.id ? "Your room" : "Shared with you"}</small></span><span className="room-date">{shortDate(room.createdAt)}</span><span className="row-arrow">↗</span></button>)}</div> : <div className="empty-state"><div className="empty-glyph">⌘</div><h3>Your next idea starts here</h3><p>Create your first room and invite someone to code alongside you.</p></div>}
      <div className="inspiration-card"><div className="inspiration-spark">✳</div><div><div className="eyebrow">A LITTLE REMINDER</div><p>“Alone we can do so little; together we can do so much.”</p><span>— HELEN KELLER</span></div><span className="inspiration-orbit orbit-one" /><span className="inspiration-orbit orbit-two" /></div>
    </section><aside className="create-panel"><div className="panel-top"><div className="panel-icon">＋</div><span className="eyebrow">MAKE A LITTLE SPACE</span></div><h2>Start a new<br /><em>collaboration.</em></h2><p>Give your room a name. We’ll make you a private link to share with your people.</p><form onSubmit={create} className="create-form"><label htmlFor="room-name">ROOM NAME</label><input id="room-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Friday side quest" maxLength={120} required /><button className="primary-button" disabled={busy}>{busy ? "Making room…" : "Create room"}<span>↗</span></button></form>{invite && <button className="invite-result" onClick={copyInvite}><span>Invite link ready</span><code>{invite.startsWith("http") ? "Copy invite link" : invite}</code></button>}<div className="panel-foot"><span>◇</span> Just you and whoever you invite.</div></aside></div>
    <footer className="dashboard-footer"><span>MADE FOR THE MOMENT WHEN IT CLICKS.</span><span>⌘ &nbsp; CODE TOGETHER</span></footer>
  </main></div>;
}

function JoinPage() {
  const { token = "" } = useParams(); const navigate = useNavigate(); const [error, setError] = useState("");
  useEffect(() => { api<{ room: Room }>(`/invites/${encodeURIComponent(token)}/accept`, { method: "POST" }).then(({ room }) => navigate(`/rooms/${room.id}`, { replace: true })).catch((e) => setError(e.message)); }, [token, navigate]);
  return <div className="loading-screen"><span className="brand-mark">⌘</span>{error ? <span>{error} <Link to="/">Go to your rooms</Link></span> : <span>Joining your room…</span>}</div>;
}

type RoomPageProps = { user: User; onLogout: () => void };
function RoomPage({ user, onLogout }: RoomPageProps) {
  const { roomId = "" } = useParams(); const navigate = useNavigate();
  const [room, setRoom] = useState<Room | null>(null); const [isOwner, setIsOwner] = useState(false); const [error, setError] = useState("");
  const [connected, setConnected] = useState(false); const [synced, setSynced] = useState(false); const [language, setLanguage] = useState<"javascript" | "python">("javascript");
  const [participants, setParticipants] = useState<{ name: string; color: string }[]>([]);
  const [stdin, setStdin] = useState(""); const [output, setOutput] = useState<RunOutput | null>(null); const [running, setRunning] = useState(false); const [inviteMessage, setInviteMessage] = useState("");
  const editorRef = useRef<any>(null); const monacoRef = useRef<any>(null); const bindingRef = useRef<MonacoBinding | null>(null);
  const doc = useMemo(() => new Y.Doc(), [roomId]);
  const provider = useMemo(() => new HocuspocusProvider({ url: wsUrl, name: `room:${roomId}`, document: doc, token: () => getAccessToken() ?? "" }), [doc, roomId]);
  const yLanguage = doc.getMap<string>("meta");

  useEffect(() => { api<{ room: Room; isOwner: boolean }>(`/rooms/${roomId}`).then((result) => { setRoom(result.room); setIsOwner(result.isOwner); }).catch((e) => { setError(e.message); }); }, [roomId]);
  useEffect(() => {
    const onStatus = (event: { status: string }) => setConnected(event.status === "connected");
    const onSynced = (event: { state: boolean }) => setSynced(Boolean(event.state));
    const updateLanguage = () => setLanguage(yLanguage.get("language") === "python" ? "python" : "javascript");
    const updateParticipants = () => {
      const states = Array.from(provider.awareness?.getStates().values() ?? []) as any[];
      setParticipants(states.map((state) => state.user).filter((person): person is { name: string; color: string } => Boolean(person?.name && person?.color)));
    };
    provider.on("status", onStatus); provider.on("synced", onSynced); yLanguage.observe(updateLanguage); updateLanguage();
    provider.awareness?.setLocalStateField("user", { name: user.displayName, color: userColor(user.id) });
    provider.awareness?.on("change", updateParticipants); updateParticipants();
    return () => { provider.off("status", onStatus); provider.off("synced", onSynced); provider.awareness?.off("change", updateParticipants); yLanguage.unobserve(updateLanguage); bindingRef.current?.destroy(); provider.destroy(); doc.destroy(); };
  }, [provider, doc, yLanguage, user]);
  // const onMount: OnMount = (editor, monaco) => { editorRef.current = editor; monacoRef.current = monaco; bindingRef.current?.destroy(); bindingRef.current = new MonacoBinding(doc.getText("code"), editor.getModel()!, new Set([editor]), provider.awareness); };
  const onMount: OnMount = async (editor, monaco) => { 
    editorRef.current = editor; 
    monacoRef.current = monaco;
    const { MonacoBinding } = await import("y-monaco"); 
    bindingRef.current?.destroy(); 
    bindingRef.current = new MonacoBinding(
      doc.getText("code"), 
      editor.getModel()!, 
      new Set([editor]), 
      provider.awareness
    ); 
  };
  const changeLanguage = (value: "javascript" | "python") => { yLanguage.set("language", value); setLanguage(value); };
  const run = async () => {
    if (!editorRef.current) return;
    setRunning(true); setOutput(null);
    try { const result = await api<RunOutput>(`/rooms/${roomId}/runs`, { method: "POST", body: JSON.stringify({ language, code: editorRef.current.getValue(), stdin }) }); setOutput(result); }
    catch (e) { setOutput({ status: "error", verdict: "ERROR", stdout: "", stderr: "", exitCode: null, error: e instanceof Error ? e.message : "Run failed" }); }
    finally { setRunning(false); }
  };
  const share = async () => {
    try { const result = await api<{ inviteToken: string }>(`/rooms/${roomId}/invites`, { method: "POST" }); await navigator.clipboard.writeText(`${location.origin}/join/${result.inviteToken}`); setInviteMessage("New invite link copied"); }
    catch (e) { setInviteMessage(e instanceof Error ? e.message : "Could not create invite"); }
    setTimeout(() => setInviteMessage(""), 3000);
  };
  const removeRoom = async () => { if (!confirm("Delete this room and its shared code?")) return; await api(`/rooms/${roomId}`, { method: "DELETE" }); navigate("/"); };
  if (error) return <div className="loading-screen"><span>{error}</span><Link to="/">Back to rooms</Link></div>;
  if (!room) return <div className="loading-screen"><span className="brand-mark">⌘</span><span>Opening the room…</span></div>;
  return <div className="room-shell">
    <header className="room-topbar"><Link to="/" className="wordmark"><span className="brand-mark">⌘</span> codesync</Link><span className="crumb-slash">/</span><span className="room-crumb">{room.name}</span><div className="room-toolbar"><div className={`connection-pill ${connected ? "is-connected" : ""}`}><span className="live-dot" />{connected && synced ? "LIVE SYNC" : connected ? "SYNCING" : "RECONNECTING"}</div><div className="presence-stack">{participants.slice(0, 4).map((person, index) => <span className="avatar presence-avatar" style={{ background: person.color, zIndex: 4 - index }} key={`${person.name}-${index}`} title={person.name}>{person.name.slice(0, 1).toUpperCase()}</span>)}<span className="presence-count">{participants.length} here</span></div><button className="outline-button share-button" onClick={share}>↗ <span>Invite</span></button><button className="user-chip room-user" onClick={onLogout}><span className="avatar avatar-lilac">{user.displayName.slice(0, 1).toUpperCase()}</span><span>{user.displayName}</span></button></div>
    </header>
    <main className="room-main"><div className="room-heading"><div><div className="eyebrow muted">A SHARED WORKSPACE</div><h1>{room.name}</h1></div><div className="room-actions"><span className="file-pill"><span className="file-dot">{language === "python" ? "Py" : "JS"}</span> main.{language === "python" ? "py" : "js"}</span>{isOwner && <button className="quiet-button delete-room" onClick={removeRoom}>Delete room</button>}</div></div>
      {inviteMessage && <div className="toast-message">{inviteMessage}</div>}
      <div className="workspace-grid"><section className="editor-panel"><div className="editor-bar"><div className="editor-tabs"><span className="tab-active"><span className="file-dot">{language === "python" ? "Py" : "JS"}</span> main.{language === "python" ? "py" : "js"}</span><span className="save-state"><span className="save-check">✓</span> {synced ? "Saved to room" : "Waiting for sync"}</span></div><div className="editor-tools"><select aria-label="Language" value={language} onChange={(e) => changeLanguage(e.target.value as "javascript" | "python")}><option value="javascript">JavaScript</option><option value="python">Python</option></select><button className="run-button" disabled={running || !connected} onClick={run}><span>{running ? "◌" : "▶"}</span>{running ? "Running…" : "Run code"}</button></div></div><div className="editor-frame"><Suspense fallback={<div className="output-placeholder">Loading editor…</div>}><Editor height="100%" language={language} theme="vs-dark" defaultValue="" onMount={onMount} options={{ minimap: { enabled: false }, fontSize: 14, lineHeight: 24, fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace", padding: { top: 18, bottom: 16 }, scrollBeyondLastLine: false, smoothScrolling: true, cursorBlinking: "smooth", renderLineHighlight: "all", automaticLayout: true, tabSize: 2, wordWrap: "on" }} /></Suspense></div><div className="editor-status"><span><span className="status-dot" /> {synced ? "All changes synced" : "Connecting to room"}</span><span>UTF-8 <b>·</b> LF <b>·</b> {language === "python" ? "Python 3" : "JavaScript"}</span></div></section>
        <aside className="run-panel"><div className="run-panel-head"><div><span className="section-kicker">TRY IT OUT</span><h2>Run your code</h2></div><span className="bolt-mark">ϟ</span></div><label className="input-label" htmlFor="stdin">STANDARD INPUT <span>OPTIONAL</span></label><textarea id="stdin" className="stdin-box" placeholder="Add input your program should receive…" value={stdin} onChange={(e) => setStdin(e.target.value)} />
          <div className="output-heading"><span className="input-label">OUTPUT</span>{output && <span className={`verdict verdict-${output.verdict === "AC" ? "ok" : "error"}`}>{output.verdict}</span>}</div><div className={`output-box ${output ? "has-output" : ""}`}>{running ? <div className="output-placeholder"><span className="spinner" /><span>Compiling and running…</span></div> : output ? <><div className="output-meta"><span>{output.verdict === "AC" ? "Finished" : "Execution result"}</span>{output.wallTimeSeconds != null && <span>{Math.round(output.wallTimeSeconds * 1000)} ms</span>}</div>{output.stdout && <pre>{output.stdout}</pre>}{output.stderr && <pre className="stderr">{output.stderr}</pre>}{output.error && !output.stderr && <pre className="stderr">{output.error}</pre>}{output.exitCode !== null && <div className="exit-code">Exit code {output.exitCode}</div>}{!output.stdout && !output.stderr && !output.error && <span className="muted-output">No output</span>}</> : <div className="output-placeholder"><span className="output-glyph">⌁</span><span>Your output will land here.</span><small>Hit run when you’re ready.</small></div>}</div><div className="runner-note"><span>◈</span> Runs in a sandboxed environment powered by Rustbox.</div></aside></div>
      <footer className="room-footer"><span>⌘ &nbsp; CODE TOGETHER, THINK OUT LOUD.</span><span>{participants.length} {participants.length === 1 ? "PERSON" : "PEOPLE"} IN THIS ROOM</span></footer>
    </main>
  </div>;
}

function userColor(id: string) { const colors = ["#d2adff", "#81d6bf", "#ffbd88", "#83b8ff", "#f19cba"]; let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0; return colors[Math.abs(hash) % colors.length]; }
