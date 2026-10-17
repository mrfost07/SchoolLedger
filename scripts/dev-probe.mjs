/**
 * Browser-equivalent probe: node fetch (same as the frontend client) sending
 * empty POSTs with no content-type, direct and through the Next proxy.
 */
const base = "http://localhost:5173";

const login = await fetch(`${base}/session/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "alice.santos@student.portal.test", password: "Password123!" }),
});
const tokens = await login.json();
console.log("login:", login.status, Boolean(tokens.accessToken));

const headers = { authorization: `Bearer ${tokens.accessToken}` };

for (const url of [`${base}/api/v1/auth/totp/setup`, "http://localhost:3000/api/v1/auth/totp/setup"]) {
  const res = await fetch(url, { method: "POST", headers });
  const body = await res.text();
  console.log("setup:", res.status, url, body.slice(0, 160));
}
