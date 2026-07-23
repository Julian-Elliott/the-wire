// The Wire service worker — receives Web Push and shows the notification.
// Payload is JSON: { title, body, why, url }.
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { body: event.data && event.data.text() }; }
  const title = d.title || "The Wire";
  const body = d.why ? `${d.body || ""}\n\nwhy: ${d.why}` : (d.body || "");
  const gentle = !!d.gentle; // Wave B scope-nudge: quieter than a p3 alert
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: gentle ? "wire-gentle" : (d.url || title), // collapse duplicates
      data: { url: d.url || "/" },
      requireInteraction: false,
      silent: gentle,             // a gentle heads-up never buzzes/pings
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) if ("focus" in w) return w.focus();
      return self.clients.openWindow(url);
    }),
  );
});
