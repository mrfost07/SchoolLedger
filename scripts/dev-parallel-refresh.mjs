/**
 * Proves the /session/refresh keyed single-flight mutex end to end:
 * two concurrent refreshes sharing one cookie must both succeed, return the
 * same rotated cookie, and that rotated cookie must still work afterwards.
 * Without the mutex the second request would reuse the old token, the backend
 * would revoke the whole family, and the follow-up would fail.
 */
const base = "http://localhost:5173";

function setCookieValue(response) {
  const raw = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  for (const entry of raw) {
    const match = entry.match(/sp_rt=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

const login = await fetch(`${base}/session/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "alice.santos@student.portal.test", password: "Password123!" }),
});
const rt = setCookieValue(login);
console.log("login:", login.status, "cookie:", Boolean(rt));

const cookieHeader = { cookie: `sp_rt=${rt}` };
const [a, b] = await Promise.all([
  fetch(`${base}/session/refresh`, { method: "POST", headers: cookieHeader }),
  fetch(`${base}/session/refresh`, { method: "POST", headers: cookieHeader }),
]);
const bodyA = await a.json();
const bodyB = await b.json();
const rtA = setCookieValue(a);
const rtB = setCookieValue(b);

console.log("parallel statuses:", a.status, b.status);
console.log("same access token:", bodyA.accessToken === bodyB.accessToken);
console.log("same rotated cookie:", Boolean(rtA) && rtA === rtB && rtA !== rt);

const follow = await fetch(`${base}/session/refresh`, {
  method: "POST",
  headers: { cookie: `sp_rt=${rtA}` },
});
console.log("rotated cookie still valid (no family revoke):", follow.status === 200);

const ok =
  a.status === 200 &&
  b.status === 200 &&
  bodyA.accessToken === bodyB.accessToken &&
  Boolean(rtA) &&
  rtA === rtB &&
  rtA !== rt &&
  follow.status === 200;
console.log(ok ? "MUTEX-PROOF: PASS" : "MUTEX-PROOF: FAIL");
process.exit(ok ? 0 : 1);
